// Picker for getDisplayMedia. Main enumerates desktopCapturer sources and
// hands them over via window.wm.screenPickerGetSources(); we render two
// grids (screens / windows) and report the selected id back. Cancel and
// the X both return null, which main interprets as "deny the request".

const screensEl = document.getElementById('screens');
const windowsEl = document.getElementById('windows');
const emptyEl   = document.getElementById('empty');
const shareBtn  = document.getElementById('share');
const cancelBtn = document.getElementById('cancel');
const closeBtn  = document.getElementById('close');

let selectedId = null;

function makeThumb(source) {
  const el = document.createElement('div');
  el.className = 'thumb';
  el.dataset.id = source.id;

  const img = document.createElement('img');
  img.src = source.thumbnail;
  img.alt = '';
  el.appendChild(img);

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = source.name || (source.type === 'screen' ? 'Screen' : 'Window');
  label.title = label.textContent;
  el.appendChild(label);

  el.addEventListener('click', () => select(source.id, el));
  el.addEventListener('dblclick', () => {
    select(source.id, el);
    submit();
  });
  return el;
}

function select(id, el) {
  selectedId = id;
  for (const e of document.querySelectorAll('.thumb.selected')) {
    e.classList.remove('selected');
  }
  el.classList.add('selected');
  shareBtn.disabled = false;
}

function submit() {
  if (!selectedId) return;
  window.wm.screenPickerSelect(selectedId);
}

function cancel() {
  window.wm.screenPickerSelect(null);
}

async function load() {
  let sources = [];
  try { sources = await window.wm.screenPickerGetSources(); } catch {}
  const screens = sources.filter((s) => s.type === 'screen');
  const wins    = sources.filter((s) => s.type !== 'screen');
  for (const s of screens) screensEl.appendChild(makeThumb(s));
  for (const s of wins)    windowsEl.appendChild(makeThumb(s));
  if (!sources.length) emptyEl.hidden = false;
}

shareBtn.addEventListener('click', submit);
cancelBtn.addEventListener('click', cancel);
closeBtn.addEventListener('click', cancel);

// Esc → cancel, Enter → share if something selected.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
  else if (e.key === 'Enter' && selectedId) submit();
});

load();
