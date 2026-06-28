-- =============================================
-- RUN THIS IN SUPABASE SQL EDITOR
-- Adds events + batch_configs tables
-- =============================================

-- Events table: stores every generated batch event
CREATE TABLE events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  batch_name TEXT NOT NULL,
  batch_number INT NOT NULL,
  event_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own events" ON events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own events" ON events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own events" ON events
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own events" ON events
  FOR DELETE USING (auth.uid() = user_id);

-- Batch configs: stores user's default duration settings (one row per user)
CREATE TABLE batch_configs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  pregnancy_days INT NOT NULL DEFAULT 115,
  breed_range INT NOT NULL DEFAULT 3,
  lock_up_before_farrowing INT NOT NULL DEFAULT 2,
  vaccinate_after_farrowing INT NOT NULL DEFAULT 10,
  weaning_after_farrowing INT NOT NULL DEFAULT 23,
  batch_spacing_days INT NOT NULL DEFAULT 14,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE batch_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own config" ON batch_configs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own config" ON batch_configs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own config" ON batch_configs
  FOR UPDATE USING (auth.uid() = user_id);
