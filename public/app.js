const sign_in_btn = document.querySelector("#sign-in-btn");
const sign_up_btn = document.querySelector("#sign-up-btn");
const container = document.querySelector(".container");

sign_up_btn.addEventListener('click', () => {
  container.classList.add("sign-up-mode");
});

sign_in_btn.addEventListener('click', () => {
  container.classList.remove("sign-up-mode");
});


const API_BASE = 'http://localhost:7000/api';


document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.querySelector('.sign-in-form');
  const registrationForm = document.querySelector('.sign-up-form');


  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = loginForm.querySelector('input[type="text"]').value.trim();
    const password = loginForm.querySelector('input[type="password"]').value;
    const role = 'employee';

    if (!username || !password) {
      showMessage('Please fill in all fields', 'error');
      return;
    }

    await handleLogin(username, password, 'employee', loginForm);
  });


  registrationForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const fullName = registrationForm.querySelectorAll('input')[0].value.trim();
    const email = registrationForm.querySelectorAll('input')[1].value.trim();
    const username = registrationForm.querySelectorAll('input')[2].value.trim();
    const password = registrationForm.querySelectorAll('input')[3].value;
    const confirmPassword = registrationForm.querySelectorAll('input')[4].value;
    const department = registrationForm.querySelectorAll('input')[5].value.trim();


    if (!fullName || !email || !username || !password || !confirmPassword) {
      showMessage('Please fill in all required fields', 'error');
      return;
    }

    if (password !== confirmPassword) {
      showMessage('Passwords do not match', 'error');
      return;
    }

    if (password.length < 6) {
      showMessage('Password must be at least 6 characters long', 'error');
      return;
    }


    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      showMessage('Please enter a valid email address', 'error');
      return;
    }

    await handleRegistration({
      full_name: fullName,
      email: email,
      username: username,
      password: password,
      department: department || null
    }, registrationForm);
  });
});


async function handleLogin(username, password, role, form) {
  const submitBtn = form.querySelector('input[type="submit"]');
  const originalText = submitBtn.value;

  try {
    submitBtn.value = 'Signing in...';
    submitBtn.disabled = true;

    showLoadingSpinner();

    const response = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username,
        password,
        role
      })
    });

    const data = await response.json();
    hideLoadingSpinner();

    if (response.ok) {
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      showMessage('Login successful! Redirecting...', 'success');
      form.reset();

      setTimeout(() => {
        window.location.href = data.redirectUrl;
      }, 1500);

    } else {
      let errorMessage = data.error || 'Login failed';
      if (response.status === 401) {
        errorMessage = 'Invalid username or password. Please try again.';
      }
      showMessage(errorMessage, 'error');
    }

  } catch (error) {
    console.error('Login error:', error);
    hideLoadingSpinner();
    showMessage('Cannot connect to server. Please try again.', 'error');
  } finally {
    submitBtn.value = originalText;
    submitBtn.disabled = false;
  }
}

async function handleRegistration(userData, form) {
  const submitBtn = form.querySelector('input[type="submit"]');
  const originalText = submitBtn.value;

  try {
    submitBtn.value = 'Creating account...';
    submitBtn.disabled = true;

    showLoadingSpinner();

    const response = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(userData)
    });

    const data = await response.json();
    hideLoadingSpinner();

    if (response.ok) {
      showMessage('Account created successfully! Please sign in.', 'success');
      form.reset();

      setTimeout(() => {
        container.classList.remove("sign-up-mode");
      }, 1500);

    } else {
      let errorMessage = data.error || 'Registration failed';
      if (response.status === 400 && data.error.includes('exists')) {
        errorMessage = 'Username or email already exists. Please try different ones.';
      }
      showMessage(errorMessage, 'error');
    }

  } catch (error) {
    console.error('Registration error:', error);
    hideLoadingSpinner();
    showMessage('Cannot connect to server. Please try again.', 'error');
  } finally {
    submitBtn.value = originalText;
    submitBtn.disabled = false;
  }
}


function showLoadingSpinner() {
  const spinner = document.createElement('div');
  spinner.className = 'loading-spinner';
  spinner.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  spinner.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 20px;
    border-radius: 10px;
    z-index: 10000;
    font-size: 1.5rem;
  `;
  document.body.appendChild(spinner);
}

function hideLoadingSpinner() {
  const spinner = document.querySelector('.loading-spinner');
  if (spinner) spinner.remove();
}

function showMessage(message, type = 'info') {
  const existing = document.querySelector('.message');
  if (existing) existing.remove();

  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${type}`;

  let icon = '';
  switch (type) {
    case 'success':
      icon = '<i class="fas fa-check-circle"></i> ';
      break;
    case 'error':
      icon = '<i class="fas fa-exclamation-triangle"></i> ';
      break;
    default:
      icon = '<i class="fas fa-info-circle"></i> ';
      break;
  }

  messageDiv.innerHTML = icon + message;
  messageDiv.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 15px 25px;
    border-radius: 10px;
    font-weight: 500;
    z-index: 10000;
    transition: all 0.3s ease;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 400px;
    text-align: center;
    backdrop-filter: blur(10px);
    ${type === 'success' ? 'background: linear-gradient(135deg, #4CAF50, #45a049); color: white;' : ''}
    ${type === 'error' ? 'background: linear-gradient(135deg, #f44336, #d32f2f); color: white;' : ''}
    ${type === 'info' ? 'background: linear-gradient(135deg, #2196F3, #1976d2); color: white;' : ''}
  `;

  document.body.appendChild(messageDiv);

  setTimeout(() => {
    if (messageDiv.parentNode) {
      messageDiv.style.opacity = '0';
      setTimeout(() => {
        if (messageDiv.parentNode) messageDiv.remove();
      }, 300);
    }
  }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.social-icon').forEach(icon => {
    icon.addEventListener('click', (e) => {
      e.preventDefault();

      let platform = 'Social';
      if (icon.querySelector('.fa-facebook-f')) platform = 'Facebook';
      else if (icon.querySelector('.fa-twitter')) platform = 'Twitter';
      else if (icon.querySelector('.fa-google')) platform = 'Google';
      else if (icon.querySelector('.fa-linkedin-in')) platform = 'LinkedIn';

      showMessage(`${platform} login not implemented yet.`, 'info');
    });
  });
});

window.addEventListener('load', async () => {
  const token = localStorage.getItem('token');
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  if (token && user.role) {
    try {
      const response = await fetch(`${API_BASE}/profile`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const redirectUrl = '/employee-dashboard';
        showMessage('Already logged in. Redirecting...', 'info');
        setTimeout(() => {
          window.location.href = redirectUrl;
        }, 1500);
      } else {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    } catch (error) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
  }
});


document.addEventListener('DOMContentLoaded', () => {
  const inputs = document.querySelectorAll('input[type="text"], input[type="password"], input[type="email"], select');

  inputs.forEach(input => {
    input.addEventListener('blur', function () {
      if (this.value.trim() === '' && this.hasAttribute('required')) {
        this.style.borderColor = '#ff6b6b';
        this.style.boxShadow = '0 0 5px rgba(255, 107, 107, 0.3)';
      } else if (this.value.trim() !== '') {
        this.style.borderColor = '#4CAF50';
        this.style.boxShadow = '0 0 5px rgba(76, 175, 80, 0.3)';
      }
    });

    input.addEventListener('focus', function () {
      this.style.borderColor = '#4481eb';
      this.style.boxShadow = '0 0 5px rgba(68, 129, 235, 0.3)';
    });
  });
});