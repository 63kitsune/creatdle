import { execFile } from "node:child_process"
import { copyFile, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises"
import { promisify } from "node:util"

const SITE_URL = "https://creatdle.dev"
const DEFAULT_IMAGE = `${SITE_URL}/social-preview.png`
const OUTPUT_DIR = process.env.PREVIEW_OUTPUT_DIR || "dist"
const TARGET_GAME_ID = String(process.env.PREVIEW_GAME_ID || "").trim()
const execFileAsync = promisify(execFile)

if (TARGET_GAME_ID && !/^[0-9a-f-]{36}$/i.test(TARGET_GAME_ID)) {
    throw new Error("PREVIEW_GAME_ID must be a UUID.")
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
}

function replaceMeta(html, attribute, key, content) {
    const pattern = new RegExp(`<meta ${attribute}="${key}" content="[^"]*" \\/>`)
    return html.replace(pattern, `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`)
}

function pageForGame(template, game, slug, previewImage) {
    const title = `${game.name || "Untitled game"} — Play on Creatdle`
    const description = String(game.description || `Guess one of ${game.item_count || "many"} possible items in this custom Creatdle game.`).slice(0, 240)
    const canonical = `${SITE_URL}/g/${encodeURIComponent(slug)}/`
    const image = previewImage || DEFAULT_IMAGE
    let html = template
        .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
        .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonical}" />`)

    html = replaceMeta(html, "name", "description", description)
    html = replaceMeta(html, "property", "og:title", title)
    html = replaceMeta(html, "property", "og:description", description)
    html = replaceMeta(html, "property", "og:url", canonical)
    html = replaceMeta(html, "property", "og:image", image)
    html = replaceMeta(html, "property", "og:image:alt", `${game.name || "Creatdle"} game preview`)
    html = replaceMeta(html, "name", "twitter:title", title)
    html = replaceMeta(html, "name", "twitter:description", description)
    html = replaceMeta(html, "name", "twitter:image", image)

    const structuredData = JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Game",
        name: game.name,
        description,
        image,
        url: canonical,
        author: game.author ? { "@type": "Person", name: game.author } : undefined,
        numberOfPlayers: { "@type": "QuantitativeValue", value: 1 },
    }).replaceAll("<", "\\u003c")

    return html.replace("</head>", `    <script type="application/ld+json">${structuredData}</script>\n  </head>`)
}

async function readProductionEnvironment() {
    const values = {}
    try {
        const source = await readFile(".env.production", "utf8")
        for (const line of source.split(/\r?\n/)) {
            const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
            if (match) values[match[1]] = match[2]
        }
    } catch {
        // Environment variables supplied by the build runner are enough.
    }
    return values
}

async function getPublicGames() {
    const fileEnvironment = await readProductionEnvironment()
    const url = process.env.VITE_SUPABASE_URL || fileEnvironment.VITE_SUPABASE_URL
    const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || fileEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY
    if (!url || !key) return []

    try {
        const response = await fetch(`${url}/rest/v1/rpc/get_public_game_previews`, {
            method: "POST",
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: "{}",
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const games = await response.json()
        return Array.isArray(games) ? games : []
    } catch (error) {
        console.warn(`Could not generate game preview pages: ${error instanceof Error ? error.message : error}`)
        return []
    }
}

function wrapText(value, lineLength, maximumLines) {
    const words = String(value || "").trim().split(/\s+/).filter(Boolean)
    const lines = []
    for (const word of words) {
        const current = lines.at(-1)
        if (!current || current.length + word.length + 1 > lineLength) lines.push(word)
        else lines[lines.length - 1] = `${current} ${word}`
    }
    if (lines.length > maximumLines) {
        lines.length = maximumLines
        lines[maximumLines - 1] = `${lines[maximumLines - 1].slice(0, Math.max(1, lineLength - 1))}…`
    }
    return lines
}

async function fetchImage(imageUrl) {
    if (!/^https?:\/\//i.test(String(imageUrl || ""))) return null
    try {
        const source = new URL(imageUrl)
        const hostname = source.hostname.toLowerCase()
        if (hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) {
            return null
        }
        const response = await fetch(source, { signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
        if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(mimeType)) throw new Error("unsupported image type")
        const declaredSize = Number(response.headers.get("content-length") || 0)
        if (declaredSize > 8_000_000) throw new Error("image is too large")
        const image = Buffer.from(await response.arrayBuffer())
        if (image.length > 8_000_000) throw new Error("image is too large")
        return { image, mimeType }
    } catch (error) {
        console.warn(`Could not cache ${imageUrl}: ${error instanceof Error ? error.message : error}`)
        return null
    }
}

async function fetchGameCover(game) {
    const candidates = [game.image, ...(Array.isArray(game.images) ? game.images : [])]
        .map(value => String(value || "").trim())
        .filter((value, index, values) => value && values.indexOf(value) === index)

    for (const candidate of candidates.slice(0, 12)) {
        const cover = await fetchImage(candidate)
        if (cover) return cover
    }
    if (candidates.length) console.warn(`No usable image was found for ${game.name || game.slug}.`)
    return null
}

async function renderGameCard(game) {
    const safeId = String(game.id).replace(/[^a-zA-Z0-9_-]/g, "")
    if (!safeId) return null
    const cover = await fetchGameCover(game)
    const titleLines = wrapText(game.name || "Untitled game", 23, 2)
    const descriptionLines = wrapText(game.description || "A custom guessing game on Creatdle.", 52, 2)
    const titleY = titleLines.length > 1 ? 320 : 360
    const descriptionY = titleLines.length > 1 ? 475 : 445
    const title = titleLines.map((line, index) => `<tspan x="72" dy="${index ? 70 : 0}">${escapeHtml(line)}</tspan>`).join("")
    const description = descriptionLines.map((line, index) => `<tspan x="74" dy="${index ? 38 : 0}">${escapeHtml(line)}</tspan>`).join("")
    const coverImage = cover
        ? `<image width="1200" height="630" preserveAspectRatio="xMidYMid slice" href="data:${cover.mimeType};base64,${cover.image.toString("base64")}"/>`
        : `<rect width="1200" height="630" fill="#242028"/><circle cx="960" cy="105" r="430" fill="#bd7d19" opacity=".2"/>`
    const author = escapeHtml(game.author || "Unknown creator")
    const itemCount = Number(game.item_count || 0)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      <defs>
        <clipPath id="card"><rect width="1200" height="630" rx="38"/></clipPath>
        <linearGradient id="shade" x1="0" y1="0" x2="1" y2=".25"><stop stop-color="#101116" stop-opacity=".93"/><stop offset=".58" stop-color="#101116" stop-opacity=".62"/><stop offset="1" stop-color="#101116" stop-opacity=".18"/></linearGradient>
        <linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1"><stop offset=".38" stop-color="#101116" stop-opacity="0"/><stop offset="1" stop-color="#101116" stop-opacity=".82"/></linearGradient>
      </defs>
      <g clip-path="url(#card)">${coverImage}<rect width="1200" height="630" fill="url(#shade)"/><rect width="1200" height="630" fill="url(#bottom)"/></g>
      <rect x="2" y="2" width="1196" height="626" rx="36" fill="none" stroke="#454750" stroke-width="4"/>
      <text x="72" y="248" fill="#58d2ff" font-family="DejaVu Sans,sans-serif" font-size="25" font-weight="700" letter-spacing="4">CREATDLE · PUBLIC GAME</text>
      <text x="72" y="${titleY}" fill="#fff" font-family="DejaVu Sans,sans-serif" font-size="68" font-weight="800" letter-spacing="-2">${title}</text>
      <text x="74" y="${descriptionY}" fill="#b9bbc3" font-family="DejaVu Sans,sans-serif" font-size="32">${description}</text>
      <text x="72" y="558" fill="#fff" font-family="DejaVu Sans,sans-serif" font-size="27" font-weight="700">${itemCount} item${itemCount === 1 ? "" : "s"} · by ${author}</text>
    </svg>`
    const directory = `${OUTPUT_DIR}/previews`
    const source = `${directory}/${safeId}.svg`
    const destination = `${directory}/${safeId}.png`
    await mkdir(directory, { recursive: true })
    await writeFile(source, svg)
    try {
        await execFileAsync("rsvg-convert", [
            "--format=png",
            "--output", destination,
            source,
        ], { timeout: 20_000 })
        return `${SITE_URL}/previews/${safeId}.png`
    } catch (error) {
        console.warn(`Could not render the preview card for ${game.name || game.slug}: ${error instanceof Error ? error.message : error}`)
        return null
    } finally {
        await unlink(source).catch(() => undefined)
    }
}

async function removeGeneratedGame(gameId) {
    const safeId = String(gameId).replace(/[^a-zA-Z0-9_-]/g, "")
    if (!safeId) return
    await rm(`${OUTPUT_DIR}/previews/${safeId}.png`, { force: true })

    const gameRoot = `${OUTPUT_DIR}/g`
    const entries = await readdir(gameRoot, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        const directory = `${gameRoot}/${entry.name}`
        const html = await readFile(`${directory}/index.html`, "utf8").catch(() => "")
        if (html.includes(`/previews/${safeId}.png`)) {
            await rm(directory, { recursive: true, force: true })
        }
    }))
}

async function generatedGameUrls() {
    const gameRoot = `${OUTPUT_DIR}/g`
    const entries = await readdir(gameRoot, { withFileTypes: true }).catch(() => [])
    return entries
        .filter(entry => entry.isDirectory() && /^[a-z0-9][a-z0-9-]{1,63}$/.test(entry.name))
        .map(entry => `${SITE_URL}/g/${encodeURIComponent(entry.name)}/`)
        .sort()
}

const template = await readFile(`${OUTPUT_DIR}/index.html`, "utf8")
const games = await getPublicGames()
const gamesToRender = TARGET_GAME_ID
    ? games.filter(game => String(game.id) === TARGET_GAME_ID)
    : games

if (TARGET_GAME_ID) {
    await removeGeneratedGame(TARGET_GAME_ID)
} else {
    await rm(`${OUTPUT_DIR}/g`, { recursive: true, force: true })
    await rm(`${OUTPUT_DIR}/previews`, { recursive: true, force: true })
}

for (const game of gamesToRender) {
    const previewImage = await renderGameCard(game)
    const slugs = new Set([game.slug, ...(Array.isArray(game.aliases) ? game.aliases : [])])
    for (const value of slugs) {
        const slug = String(value || "")
        if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) continue
        const directory = `${OUTPUT_DIR}/g/${slug}`
        await mkdir(directory, { recursive: true })
        await writeFile(`${directory}/index.html`, pageForGame(template, game, slug, previewImage))
    }
}

const sitemapUrls = [`${SITE_URL}/`, ...await generatedGameUrls()]
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...sitemapUrls].map(url => `  <url><loc>${url}</loc></url>`).join("\n")}\n</urlset>\n`
await writeFile(`${OUTPUT_DIR}/sitemap.xml`, sitemap)
await writeFile(`${OUTPUT_DIR}/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`)
await copyFile(`${OUTPUT_DIR}/index.html`, `${OUTPUT_DIR}/404.html`)
await writeFile(`${OUTPUT_DIR}/.nojekyll`, "")
