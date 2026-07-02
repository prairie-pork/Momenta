-- =============================================
-- RUN THIS IN SUPABASE SQL EDITOR
-- Complete production schema: calendars, members, invites, events, notes, settings
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

-- Core app tables. Kept here so this file is safe to run on a fresh project.
CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  batch_name TEXT NOT NULL,
  batch_number INT NOT NULL,
  event_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  is_private BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL,
  day INT NOT NULL,
  col1 TEXT DEFAULT '',
  col2 TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS batch_configs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  pregnancy_days INT NOT NULL DEFAULT 115,
  breed_range INT NOT NULL DEFAULT 3,
  lock_up_before_farrowing INT NOT NULL DEFAULT 2,
  vaccinate_after_farrowing INT NOT NULL DEFAULT 10,
  weaning_after_farrowing INT NOT NULL DEFAULT 23,
  batch_spacing_days INT NOT NULL DEFAULT 14,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custom_event_types (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  calendar_id UUID REFERENCES calendars(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  duration_days INT NOT NULL DEFAULT 1 CHECK (duration_days BETWEEN 1 AND 30),
  is_private BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_event_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own config" ON batch_configs;
DROP POLICY IF EXISTS "Users can insert their own config" ON batch_configs;
DROP POLICY IF EXISTS "Users can update their own config" ON batch_configs;
DROP POLICY IF EXISTS "batch_configs_select" ON batch_configs;
DROP POLICY IF EXISTS "batch_configs_insert" ON batch_configs;
DROP POLICY IF EXISTS "batch_configs_update" ON batch_configs;

CREATE POLICY "batch_configs_select" ON batch_configs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "batch_configs_insert" ON batch_configs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "batch_configs_update" ON batch_configs
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "custom_event_types_select" ON custom_event_types;
DROP POLICY IF EXISTS "custom_event_types_insert" ON custom_event_types;
DROP POLICY IF EXISTS "custom_event_types_update" ON custom_event_types;
DROP POLICY IF EXISTS "custom_event_types_delete" ON custom_event_types;

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
  WITH CHECK (
    auth.uid() = created_by
    AND calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
  );

CREATE POLICY "invites_owner_delete" ON invite_codes FOR DELETE
  USING (calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid()));

-- Invite redemption happens only through redeem_invite(); no public invite reads/updates.
CREATE TABLE IF NOT EXISTS invite_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE invite_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invite_attempts_no_client_access" ON invite_attempts;

CREATE OR REPLACE FUNCTION redeem_invite(invite_code TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  inv invite_codes%ROWTYPE;
  caller_id UUID := auth.uid();
  caller_email TEXT := lower(coalesce(auth.jwt() ->> 'email', ''));
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'You must be logged in to join a farm.';
  END IF;

  DELETE FROM invite_attempts WHERE attempted_at < now() - interval '15 minutes';

  IF (
    SELECT COUNT(*)
    FROM invite_attempts
    WHERE user_id = caller_id
      AND attempted_at > now() - interval '15 minutes'
  ) >= 10 THEN
    RAISE EXCEPTION 'Too many invite attempts. Please wait a few minutes and try again.';
  END IF;

  INSERT INTO invite_attempts (user_id) VALUES (caller_id);

  SELECT *
    INTO inv
    FROM invite_codes
    WHERE code = upper(trim(invite_code))
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid invite code.';
  END IF;

  IF inv.used_by IS NOT NULL THEN
    RAISE EXCEPTION 'This invite code has already been used.';
  END IF;

  IF inv.expires_at <= now() THEN
    RAISE EXCEPTION 'This invite code has expired.';
  END IF;

  IF lower(inv.email) <> caller_email THEN
    RAISE EXCEPTION 'This invite code is not for your email address.';
  END IF;

  INSERT INTO calendar_members (calendar_id, user_id, role)
  VALUES (inv.calendar_id, caller_id, 'editor')
  ON CONFLICT (calendar_id, user_id) DO NOTHING;

  UPDATE invite_codes
    SET used_by = caller_id,
        used_at = now()
    WHERE id = inv.id;

  RETURN inv.calendar_id;
END;
$$;

REVOKE ALL ON FUNCTION redeem_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redeem_invite(TEXT) TO authenticated;

-- 4. Add calendar_id to existing tables
ALTER TABLE events ADD COLUMN IF NOT EXISTS calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS calendar_id UUID REFERENCES calendars(id) ON DELETE CASCADE;

-- Custom event types are account-level now. They can be used on any farm and
-- should survive when a farm is deleted.
ALTER TABLE custom_event_types ALTER COLUMN calendar_id DROP NOT NULL;
ALTER TABLE custom_event_types ADD COLUMN IF NOT EXISTS duration_days INT NOT NULL DEFAULT 1;
ALTER TABLE custom_event_types ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE custom_event_types DROP CONSTRAINT IF EXISTS custom_event_types_duration_days_check;
ALTER TABLE custom_event_types ADD CONSTRAINT custom_event_types_duration_days_check CHECK (duration_days BETWEEN 1 AND 30);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'custom_event_types_calendar_id_fkey'
      AND table_name = 'custom_event_types'
  ) THEN
    ALTER TABLE custom_event_types
      DROP CONSTRAINT custom_event_types_calendar_id_fkey,
      ADD CONSTRAINT custom_event_types_calendar_id_fkey
        FOREIGN KEY (calendar_id) REFERENCES calendars(id) ON DELETE SET NULL;
  END IF;
END;
$$;

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

CREATE OR REPLACE FUNCTION can_access_calendar(cal_id UUID, uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM calendars WHERE id = cal_id AND owner_id = uid)
    OR EXISTS (SELECT 1 FROM calendar_members WHERE calendar_id = cal_id AND user_id = uid);
$$;

CREATE POLICY "custom_event_types_select" ON custom_event_types FOR SELECT
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM events e
      WHERE e.event_type = 'custom:' || custom_event_types.id::text
      AND can_access_calendar(e.calendar_id, auth.uid())
    )
    OR (
      custom_event_types.gestation_day IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM calendar_members cm
        WHERE cm.user_id = auth.uid()
        AND cm.calendar_id IN (
          SELECT cm2.calendar_id FROM calendar_members cm2
          WHERE cm2.user_id = custom_event_types.created_by
        )
      )
    )
  );

CREATE POLICY "custom_event_types_insert" ON custom_event_types FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND (calendar_id IS NULL OR can_access_calendar(calendar_id, auth.uid()))
  );

CREATE POLICY "custom_event_types_update" ON custom_event_types FOR UPDATE
  USING (created_by = auth.uid())
  WITH CHECK (
    created_by = auth.uid()
    AND (calendar_id IS NULL OR can_access_calendar(calendar_id, auth.uid()))
  );

CREATE POLICY "custom_event_types_delete" ON custom_event_types FOR DELETE
  USING (created_by = auth.uid());

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
    can_access_calendar(calendar_id, auth.uid())
    AND (is_private IS NOT TRUE OR user_id = auth.uid())
  );

CREATE POLICY "events_insert" ON events FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND can_access_calendar(calendar_id, auth.uid())
  );

CREATE POLICY "events_update" ON events FOR UPDATE
  USING (
    can_access_calendar(calendar_id, auth.uid())
    AND (is_private IS NOT TRUE OR user_id = auth.uid())
  )
  WITH CHECK (
    can_access_calendar(calendar_id, auth.uid())
    AND (is_private IS NOT TRUE OR user_id = auth.uid())
  );

CREATE POLICY "events_delete" ON events FOR DELETE
  USING (
    can_access_calendar(calendar_id, auth.uid())
    AND (is_private IS NOT TRUE OR user_id = auth.uid())
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
  USING (can_access_calendar(calendar_id, auth.uid()));

CREATE POLICY "ce_insert" ON calendar_events FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND can_access_calendar(calendar_id, auth.uid())
  );

CREATE POLICY "ce_update" ON calendar_events FOR UPDATE
  USING (can_access_calendar(calendar_id, auth.uid()))
  WITH CHECK (can_access_calendar(calendar_id, auth.uid()));

CREATE POLICY "ce_delete" ON calendar_events FOR DELETE
  USING (can_access_calendar(calendar_id, auth.uid()));

-- 7. Remove auto-created Personal calendars — users create/share farms only
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS create_default_calendar;

-- 8. Remove all existing Personal calendars (data stays orphaned, users migrate to farms)
DELETE FROM calendar_events WHERE calendar_id IN (SELECT id FROM calendars WHERE type = 'personal');
DELETE FROM events WHERE calendar_id IN (SELECT id FROM calendars WHERE type = 'personal');
DELETE FROM calendars WHERE type = 'personal';

-- 9. Function to look up user emails for farms the caller can access
CREATE OR REPLACE FUNCTION get_user_emails(ids UUID[])
RETURNS TABLE(user_id UUID, email TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth
AS $$
  SELECT DISTINCT u.id, u.email
  FROM auth.users u
  JOIN calendar_members target_member
    ON target_member.user_id = u.id
  WHERE u.id = ANY(ids)
    AND (
      target_member.calendar_id IN (SELECT id FROM calendars WHERE owner_id = auth.uid())
      OR target_member.calendar_id IN (
        SELECT calendar_id FROM calendar_members WHERE user_id = auth.uid()
      )
    );
$$;

REVOKE ALL ON FUNCTION get_user_emails(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_user_emails(UUID[]) TO authenticated;

-- 10. Enable real-time replication so edits sync across farm members
ALTER TABLE calendar_members REPLICA IDENTITY FULL;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'calendar_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calendar_members;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'custom_event_types'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE custom_event_types;
  END IF;
END;
$$;

-- 11. Gestation event columns
ALTER TABLE custom_event_types ADD COLUMN IF NOT EXISTS gestation_day INT CHECK (gestation_day IS NULL OR gestation_day BETWEEN 1 AND 120);
ALTER TABLE batch_configs ADD COLUMN IF NOT EXISTS show_gestation_events BOOLEAN NOT NULL DEFAULT false;
