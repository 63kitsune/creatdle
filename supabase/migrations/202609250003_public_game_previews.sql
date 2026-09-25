-- Public, approved-only metadata used to generate social preview pages.
begin;

create or replace function public.get_public_game_previews()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', g.id,
      'slug', coalesce(g.public_slug, g.slug),
      'name', g.approved_name,
      'description', g.approved_description,
      'author', g.approved_author_name,
      'image', g.approved_cover_image,
      'images', jsonb_build_array(
        g.approved_cover_image,
        g.approved_content #>> '{settings,image}'
      ) || coalesce(
        jsonb_path_query_array(
          g.approved_content,
          '$.items[*].picture ? (@.type() == "string")'
        ),
        '[]'::jsonb
      ),
      'item_count', g.approved_item_count,
      'updated_at', g.approved_at,
      'aliases', coalesce((
        select jsonb_agg(a.slug order by a.created_at)
        from public.game_aliases a
        where a.game_id = g.id
      ), '[]'::jsonb)
    ) order by g.approved_at desc
  ), '[]'::jsonb)
  from public.games g
  -- Only games that are approved right now belong in generated social pages.
  where g.approved_content is not null
    and g.status in ('accepted', 'featured');
$$;

revoke all on function public.get_public_game_previews() from public;
grant execute on function public.get_public_game_previews() to anon, authenticated;

commit;
