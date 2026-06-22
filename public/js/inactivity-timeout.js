// Inactivity Auto Logout - 10 Minutes
(function() {
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const WARNING_MS = 60 * 1000; // Show warning at 1 minute remaining
  const PING_INTERVAL = 60 * 1000; // Ping server every 1 min on activity
  
  let warningModal = null;
  let logoutTimer = null;
  let warningTimer = null;
  let lastActivity = Date.now();
  let pingTimer = null;
  let hasActivity = false;

  function sendPing() {
    if (hasActivity) {
      hasActivity = false;
      fetch('/session/ping', { method: 'GET', cache: 'no-store' }).catch(function(){});
    }
  }

  function resetTimers() {
    lastActivity = Date.now();
    hasActivity = true;
    clearTimeout(warningTimer);
    clearTimeout(logoutTimer);
    
    warningTimer = setTimeout(showWarning, TIMEOUT_MS - WARNING_MS);
    logoutTimer = setTimeout(doLogout, TIMEOUT_MS);
    
    if (warningModal) {
      warningModal.remove();
      warningModal = null;
    }
  }

  function showWarning() {
    warningModal = document.createElement('div');
    warningModal.id = 'inactivity-warning';
    warningModal.innerHTML = `
      <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:999999;">
        <div style="background:white;padding:30px;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 10px 40px rgba(0,0,0,0.3);">
          <h3 style="color:#1e293b;margin-bottom:15px;font-size:20px;">Session Timeout</h3>
          <p style="color:#64748b;margin-bottom:20px;">You will be logged out in <span id="countdown" style="color:#ef4444;font-weight:bold;">60</span> seconds due to inactivity.</p>
          <button onclick="stayLoggedIn()" style="background:#667eea;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer;margin-right:10px;">Stay Logged In</button>
          <button onclick="logoutNow()" style="background:#ef4444;color:white;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer;">Logout Now</button>
        </div>
      </div>
    `;
    document.body.appendChild(warningModal);
    
    let countdown = 60;
    const countdownEl = warningModal.querySelector('#countdown');
    const countdownInterval = setInterval(() => {
      countdown--;
      countdownEl.textContent = countdown;
      if (countdown <= 0) clearInterval(countdownInterval);
    }, 1000);
  }

  window.stayLoggedIn = function() {
    resetTimers();
  };

  window.logoutNow = function() {
    window.location.href = '/logout';
  };

  function doLogout() {
    window.location.href = '/logout';
  }

  // Track all user activities
  const events = ['mousedown', 'mousemove', 'keydown', 'scroll', 'touchstart', 'click'];
  events.forEach(event => {
    document.addEventListener(event, resetTimers, { passive: true });
  });

  // Also track in iframes
  window.addEventListener('blur', resetTimers);
  window.addEventListener('focus', resetTimers);

  // Initialize timers on page load
  resetTimers();
  pingTimer = setInterval(sendPing, PING_INTERVAL);
})();