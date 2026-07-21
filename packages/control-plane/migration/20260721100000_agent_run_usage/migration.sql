CREATE TABLE agent_run_usage (
  agent_run_id text PRIMARY KEY NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  source text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  time_updated integer NOT NULL,
  CONSTRAINT agent_run_usage_source_check CHECK (source IN ('runtime', 'unavailable'))
);
