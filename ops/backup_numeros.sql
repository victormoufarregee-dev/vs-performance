-- Os números que o backup restaurado tem de repetir exatamente.
-- Roda no banco de produção e no restaurado; o workflow compara linha a linha.
select 'tabela ' || c.relname || ' ' ||
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
 order by c.relname;
select 'funcoes vsp ' || count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'vsp%';
select 'policies ' || count(*) from pg_policies where schemaname = 'public';
select 'caixa esperado ' || public.vsp_caixa_esperado_calc();
select 'divida victor ' || public.vsp_saldo_victor();
select 'estoque ' || round(sum(caixas * custo_caixa + frascos * custo_frasco), 2) from public.produtos;
