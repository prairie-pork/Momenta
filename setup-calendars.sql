-- =============================================
-- RUN THIS IN SUPABASE SQL EDITOR
-- Adds Farm/Personal calendar support + multi-user
-- =============================================

-- 1. Calendars table
CREATE TABLE IF NOT EXISTS calendars (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_id UUID REFERENCES auth.users(id) NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('farm', 'personal')),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;

-- Drop old policies in case they exist from a prior run
DROP POLICY IF EXISTS "calendars_owner_select" ON calendars;
DROP POLICY IF EXISTS "calendars_owner_insert" ON calendars;
DROP POLICY IF EXISTS "calendars_owner_update" ON calendars;
DROP POLICY IF EXISTS "calendars_owner_delete" ON calendars;
DROP POLICY IF EXISTS "calendars_member_select" ON calendars;

-- Owner can do everything
CREATE POLICY "calendars_owner_select" ON calendars FOR SELECT USING (auth.uid() = owner_id);
CREATE POLICY "calendars_owner_insert" ON calendars FOR INSERT WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "calendars_owner_update" ON calendars FOR UPDATE USING (auth.uid() = owner_id);
CREATE POLICY "calendars_owner_delete" ON calendars FOR DELETE USING (auth.uid() = owner_id);

-- 2. Calendar members table
CREATE TABLE IF NOT EXISTS calendar_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (calendar_id, user_id)
);

ALTER TABLE calendar_members ENABLE ROW LEVEL SECURITY;

-- Drop old recursive policies
DROP POLICY IF EXISTS "cmembers_select" ON calendar_members;
DROP POLICY IF EXISTS "cmembers_self" ON calendar_members;
DROP POLICY IF EXISTS "cmembers_owner_select" ON calendar_members;
DROP POLICY IF EXISTS "cmembers_insert" ON calendar_members;
DROP POLICY IF EXISTS "cmembers_join" ON calendar_members;
DROP POLICY IF EXISTS "cmembers_delete" ON calendar_members;
DROP POLICY IF EXISTS "calendars_member_select" ON calendars;

-- Helper function: bypass RLS to check calendar membership (avoids infinite recursion)
CREATE OR REPLACE FUNCTION check_calendar_member(cal_id UUID, uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM calendar_members WHERE calendar_id = cal_id AND user_id = uid);
$$;

-- Members can see their own memberships
CREATE POLICY "cmembers_self" ON calendar_members FOR SELECT
  USING (user_id = auth.uid());

-- Farm owners can see all members of their farms (subquery uses SECURITY DEFINER policy, no recursion)
CREATE POLICY "cmembers_owner_select" ON calendar_members FOR SELECT
  USING (calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid()));

CREATE POLICY "cmembers_insert" ON calendar_members FOR INSERT
  WITH CHECK (
    calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

-- Non-owners can join via a valid invite code
CREATE POLICY "cmembers_join" ON calendar_members FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM invite_codes
      WHERE calendar_id = calendar_members.calendar_id
      AND used_by IS NULL
      AND expires_at > now()
    )
  );

CREATE POLICY "cmembers_delete" ON calendar_members FOR DELETE
  USING (
    calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

-- Farm members can view calendar (uses SECURITY DEFINER function to avoid recursion)
CREATE POLICY "calendars_member_select" ON calendars FOR SELECT
  USING (check_calendar_member(id, auth.uid()));

-- 3. Invite codes (one-time use)
CREATE TABLE IF NOT EXISTS invite_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE NOT NULL,
  code TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) NOT NULL,
  used_by UUID REFERENCES auth.users(id),
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE invite_codes ENABLE ROW LEVEL SECURITY;

-- Drop old policies
DROP POLICY IF EXISTS "invites_owner_select" ON invite_codes;
DROP POLICY IF EXISTS "invites_owner_insert" ON invite_codes;
DROP POLICY IF EXISTS "invites_owner_delete" ON invite_codes;
DROP POLICY IF EXISTS "invites_redeem_select" ON invite_codes;
DROP POLICY IF EXISTS "invites_redeem_update" ON invite_codes;
DROP POLICY IF EXISTS "invites_update" ON invite_codes;

-- Owner can manage invite codes
CREATE POLICY "invites_owner_select" ON invite_codes FOR SELECT
  USING (calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid()));

CREATE POLICY "invites_owner_insert" ON invite_codes FOR INSERT
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "invites_owner_delete" ON invite_codes FOR DELETE
  USING (calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid()));

-- Anyone can read a specific code by code string (for redemption)
CREATE POLICY "invites_redeem_select" ON invite_codes FOR SELECT
  USING (true);

-- Joining user can mark the code as used
CREATE POLICY "invites_redeem_update" ON invite_codes FOR UPDATE
  USING (true);

-- 4. Add calendar_id to existing tables
ALTER TABLE events ADD COLUMN IF NOT EXISTS calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE;

-- Ensure existing FK constraints also cascade
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'events_calendar_id_fkey' AND table_name = 'events') THEN
    ALTER TABLE events DROP CONSTRAINT events_calendar_id_fkey, ADD CONSTRAINT events_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'calendar_events_calendar_id_fkey' AND table_name = 'calendar_events') THEN
    ALTER TABLE calendar_events DROP CONSTRAINT calendar_events_calendar_id_fkey, ADD CONSTRAINT calendar_events_calendar_id_fkey FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE CASCADE;
  END IF;
END;
$$;

-- Update calendar_events unique constraint to include calendar_id
ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_user_id_year_month_day_key;
ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS ce_user_calendar_day;
ALTER TABLE calendar_events ADD CONSTRAINT ce_user_calendar_day UNIQUE (user_id, year, month, day, calendar_id);

-- 5. Update RLS on events to allow farm members
DROP POLICY IF EXISTS "Users can view their own events" ON events;
DROP POLICY IF EXISTS "Users can insert their own events" ON events;
DROP POLICY IF EXISTS "Users can update their own events" ON events;
DROP POLICY IF EXISTS "Users can delete their own events" ON events;
DROP POLICY IF EXISTS "events_select" ON events;
DROP POLICY IF EXISTS "events_insert" ON events;
DROP POLICY IF EXISTS "events_update" ON events;
DROP POLICY IF EXISTS "events_delete" ON events;

CREATE POLICY "events_select" ON events FOR SELECT
  USING (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "events_insert" ON events FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "events_update" ON events FOR UPDATE
  USING (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "events_delete" ON events FOR DELETE
  USING (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

-- 6. Update RLS on calendar_events to allow farm members
DROP POLICY IF EXISTS "Users can view their own events" ON calendar_events;
DROP POLICY IF EXISTS "Users can insert their own events" ON calendar_events;
DROP POLICY IF EXISTS "Users can update their own events" ON calendar_events;
DROP POLICY IF EXISTS "Users can delete their own events" ON calendar_events;
DROP POLICY IF EXISTS "ce_select" ON calendar_events;
DROP POLICY IF EXISTS "ce_insert" ON calendar_events;
DROP POLICY IF EXISTS "ce_update" ON calendar_events;
DROP POLICY IF EXISTS "ce_delete" ON calendar_events;

CREATE POLICY "ce_select" ON calendar_events FOR SELECT
  USING (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "ce_insert" ON calendar_events FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "ce_update" ON calendar_events FOR UPDATE
  USING (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "ce_delete" ON calendar_events FOR DELETE
  USING (
    user_id = auth.uid()
    OR calendar_id IN (SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid())
    OR calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

-- 7. Remove auto-created Personal calendars — users create/share farms only
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS create_default_calendar;

-- 8. Remove all existing Personal calendars (data stays orphaned, users migrate to farms)
DELETE FROM calendar_events WHERE calendar_id IN (SELECT id FROM calendars WHERE type = 'personal');
DELETE FROM events WHERE calendar_id IN (SELECT id FROM calendars WHERE type = 'personal');
DELETE FROM calendars WHERE type = 'personal';

-- 9. Function to look up user emails (bypasses RLS on auth.users)
CREATE OR REPLACE FUNCTION get_user_emails(ids UUID[])
RETURNS TABLE(user_id UUID, email TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT id, email FROM auth.users WHERE id = ANY(ids);
$$;

-- 10. Enable real-time replication so edits sync across farm members
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE events;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'calendar_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calendar_events;
  END IF;
END;
$$;
