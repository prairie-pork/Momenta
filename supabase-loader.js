(function () {
  const urls = [
    'vendor/supabase.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js'
  ];

  function showLoadError() {
    const message = 'Could not load the login service. Check your internet connection and refresh.';
    const authMessage = document.getElementById('auth-message');
    const loadingScreen = document.getElementById('loading-screen');

    if (authMessage) {
      authMessage.textContent = message;
      authMessage.className = 'auth-message error';
    }
    if (loadingScreen) {
      loadingScreen.innerHTML = '<p>' + message + '</p>';
      loadingScreen.style.display = 'flex';
    }
  }

  function loadNext(index) {
    if (index >= urls.length) {
      window.supabaseLoadFailed = true;
      showLoadError();
      return;
    }

    const script = document.createElement('script');
    script.src = urls[index];
    script.onload = function () {
      window.supabaseLibraryReady = true;
      document.dispatchEvent(new Event('supabase-library-ready'));
    };
    script.onerror = function () {
      loadNext(index + 1);
    };
    document.head.appendChild(script);
  }

  loadNext(0);
})();
