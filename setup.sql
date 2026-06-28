-- =============================================
-- RUN THIS IN SUPABASE SQL EDITOR
-- Go to: Supabase Dashboard -> SQL Editor -> Paste -> Run
-- =============================================

-- Step 1: Drop the old insecure table
DROP TABLE IF EXISTS calendar_events;

-- Step 2: Create new table with user_id ownership
CREATE TABLE calendar_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL,
  day INT NOT NULL,
  col1 TEXT DEFAULT '',
  col2 TEXT DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, year, month, day)
);

-- Step 3: Turn on Row Level Security
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

-- Step 4: Create security policies
CREATE POLICY "Users can view their own events" ON calendar_events
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own events" ON calendar_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own events" ON calendar_events
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own events" ON calendar_events
  FOR DELETE USING (auth.uid() = user_id);
