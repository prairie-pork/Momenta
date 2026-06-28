// =============================================
// Supabase Client Setup
// =============================================
// This uses the UMD build of Supabase, which was loaded via a <script> tag
// in the HTML. The UMD build creates a global "supabase" object on window.
// createClient() connects our app to the Supabase backend.
const SUPABASE_URL = 'https://awanuagzpmakudoaymzl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3YW51YWd6cG1ha3Vkb2F5bXpsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1ODIxMDUsImV4cCI6MjA5ODE1ODEwNX0.4EwcahDqv5TmMLMU0OfnhdrhmH8q9Z3C61DiH3MpuM8';

// Create the Supabase client and store it on window so other scripts can access it
window.supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =============================================
// SIGN UP - Create a new account
// =============================================
window.signUp = async function (email, password) {
  const { data, error } = await window.supabase.auth.signUp({
    email: email,
    password: password,
  });
  if (error) throw error;
  return data;
};

// =============================================
// SIGN IN - Log in to an existing account
// =============================================
window.signIn = async function (email, password) {
  const { data, error } = await window.supabase.auth.signInWithPassword({
    email: email,
    password: password,
  });
  if (error) throw error;
  return data;
};

// =============================================
// SIGN OUT - Log the user out
// =============================================
window.signOut = async function () {
  const { error } = await window.supabase.auth.signOut();
  if (error) throw error;
};

// =============================================
// GET CURRENT USER - Who is logged in right now?
// =============================================
window.getCurrentUser = async function () {
  const { data: { user } } = await window.supabase.auth.getUser();
  return user;
};

// =============================================
// PROTECTED PAGE CHECK - Block access if not logged in
// =============================================
window.requireAuth = async function () {
  const user = await window.getCurrentUser();
  if (!user) {
    window.location.href = 'login.html?redirected=true';
    return null;
  }
  return user;
};
