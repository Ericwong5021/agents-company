CREATE TABLE company_setup_goal (
  company_id text PRIMARY KEY NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  body text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
