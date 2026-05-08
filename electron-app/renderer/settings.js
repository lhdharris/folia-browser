const drmToggle      = document.getElementById('drm-toggle');
const closeBtn       = document.getElementById('close');
const downloadPathEl = document.getElementById('download-path');
const pickFolderBtn  = document.getElementById('pick-download-folder');
const askToggle      = document.getElementById('ask-download-toggle');

let defaultDownloadPath = '';

function renderDownloadPath(s) {
  const ask = s.askDownloadPath === true;
  askToggle.checked = ask;
  downloadPathEl.textContent = s.downloadPath || defaultDownloadPath;
  downloadPathEl.classList.toggle('dim', ask);
  pickFolderBtn.disabled = ask;
}

async function init() {
  defaultDownloadPath = await window.wm.getDefaultDownloadPath();
  const s = await window.wm.getSettings();
  const engine = s.searchEngine || 'duckduckgo';
  const radio  = document.querySelector(`input[name="searchEngine"][value="${engine}"]`);
  if (radio) radio.checked = true;
  drmToggle.checked = s.drmEnabled === true;
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

function flashConfirm(buttonId) {
  const tag = document.querySelector(`.confirm[data-for="${buttonId}"]`);
  if (!tag) return;
  tag.classList.add('show');
  setTimeout(() => tag.classList.remove('show'), 1400);
}

document.getElementById('delete-cookies').addEventListener('click', async () => {
  await window.wm.deleteCookies();
  flashConfirm('delete-cookies');
});

document.getElementById('delete-cache').addEventListener('click', async () => {
  await window.wm.deleteCache();
  flashConfirm('delete-cache');
});

closeBtn.addEventListener('click', () => window.wm.close());

init();
