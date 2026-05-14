const drmToggle      = document.getElementById('drm-toggle');
const closeBtn       = document.getElementById('close');
const downloadPathEl = document.getElementById('download-path');
const pickFolderBtn  = document.getElementById('pick-download-folder');
const askToggle      = document.getElementById('ask-download-toggle');
const zoomSelect     = document.getElementById('zoom-select');

let defaultDownloadPath = '';

function renderDownloadPath(s) {
  const ask = s.askDownloadPath === true;
  askToggle.checked = ask;
  downloadPathEl.textContent = s.downloadPath || defaultDownloadPath;
  downloadPathEl.classList.toggle('dim', ask);
  pickFolderBtn.disabled = ask;
}

async function init() {
  window.wm.getAppVersion().then((v) => {
    document.getElementById('version-number').textContent = v || '';
  });
  defaultDownloadPath = await window.wm.getDefaultDownloadPath();
  const s = await window.wm.getSettings();
  const engine = s.searchEngine || 'ecosia';
  const radio  = document.querySelector(`input[name="searchEngine"][value="${engine}"]`);
  if (radio) radio.checked = true;
  drmToggle.checked = s.drmEnabled === true;
  zoomSelect.value = String(s.zoom ?? 1);
  renderDownloadPath(s);
}

document.querySelectorAll('input[name="searchEngine"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (r.checked) window.wm.saveSettings({ searchEngine: r.value });
  });
});

drmToggle.addEventListener('change', () => {
  window.wm.saveSettings({ drmEnabled: drmToggle.checked });
});

zoomSelect.addEventListener('change', () => {
  const z = parseFloat(zoomSelect.value);
  if (!isNaN(z)) window.wm.saveSettings({ zoom: z });
});

askToggle.addEventListener('change', async () => {
  window.wm.saveSettings({ askDownloadPath: askToggle.checked });
  const s = await window.wm.getSettings();
  renderDownloadPath(s);
});

pickFolderBtn.addEventListener('click', async () => {
  const picked = await window.wm.pickDownloadFolder();
  if (!picked) return;
  const s = await window.wm.getSettings();
  renderDownloadPath(s);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Briefly swap a button's label to its data-flash text (e.g. "Deleted!") in
// green: fade out, swap, fade in, hold, fade out, restore, fade in. CSS owns
// the fade timing via `.action` transition; this just toggles opacity and
// swaps text/class at each step.
async function flashButton(btn) {
  if (btn._flashing) return;
  btn._flashing = true;
  const original = btn.textContent;
  btn.style.opacity = '0';
  await wait(180);
  btn.textContent = btn.dataset.flash || 'Done!';
  btn.classList.add('flashed');
  btn.style.opacity = '1';
  await wait(700);
  btn.style.opacity = '0';
  await wait(180);
  btn.textContent = original;
  btn.classList.remove('flashed');
  btn.style.opacity = '';
  btn._flashing = false;
}

// Fire the flash immediately and kick off the deletion in parallel — both
// `clearStorageData` and `clearCache` are local and effectively instant, and
// awaiting them first would null out e.currentTarget before flashButton ran.
document.getElementById('delete-cookies').addEventListener('click', (e) => {
  window.wm.deleteCookies();
  flashButton(e.currentTarget);
});

document.getElementById('delete-cache').addEventListener('click', (e) => {
  window.wm.deleteCache();
  flashButton(e.currentTarget);
});

closeBtn.addEventListener('click', () => window.wm.close());

init();
