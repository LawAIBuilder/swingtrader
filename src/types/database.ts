// This hand-written type is intentionally minimal. After you apply supabase/schema.sql,
// run `npm run db:types` to generate exact Supabase types into database.generated.ts.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type GenericTable = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: [];
};

type GenericView = {
  Row: Record<string, unknown>;
  Relationships: [];
};

type GenericSchema = {
  Tables: Record<string, GenericTable>;
  Views: Record<string, GenericView>;
  Functions: Record<string, never>;
  Enums: Record<string, never>;
  CompositeTypes: Record<string, never>;
};

export interface Database {
  public: GenericSchema;
  bounce_trader: GenericSchema;
}
