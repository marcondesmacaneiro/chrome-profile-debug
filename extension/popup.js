/**
 * Popup for Chrome Profile Debug.
 *
 * The name is the opt-in switch: with no name the service worker never calls
 * connectNative, so saving an empty name takes the profile off the bridge.
 */

const STATUS_POLL_MS = 1000;

const nameInput = document.getElementById('profile-name');
const saveButton = document.getElementById('save');
const statusLine = document.getElementById('status');

let nameTouched = false;

function statusText(status) {
  if (!status || status.state === 'unnamed') return 'Not named — this profile is not exposed';
  if (status.state === 'connected') return `Connected as ${status.name}`;
  return 'Connecting...';
}

function render(status) {
  statusLine.textContent = statusText(status);
  // Never overwrite what the user is in the middle of typing.
  if (!nameTouched && document.activeElement !== nameInput) {
    nameInput.value = status?.name ?? '';
  }
}

async function requestStatus() {
  try {
    return await chrome.runtime.sendMessage({ type: 'cpd.getStatus' });
  } catch {
    return null;
  }
}

async function save() {
  saveButton.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({
      type: 'cpd.setName',
      name: nameInput.value
    });
    nameTouched = false;
    render(status);
  } catch (error) {
    statusLine.textContent = `Could not save: ${error?.message ?? error}`;
  } finally {
    saveButton.disabled = false;
  }
}

saveButton.addEventListener('click', () => {
  save();
});

nameInput.addEventListener('input', () => {
  nameTouched = true;
});

nameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') save();
});

async function refresh() {
  render(await requestStatus());
}

refresh();
setInterval(refresh, STATUS_POLL_MS);
