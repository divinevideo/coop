-- Fresh production databases need the same maintenance cursor as existing
-- installations. Use the table's existing default and preserve every cursor.
INSERT INTO public.view_maintenance_metadata (table_name)
VALUES ('manual_review_tool.dim_mrt_decisions_materialized')
ON CONFLICT (table_name) DO NOTHING;
