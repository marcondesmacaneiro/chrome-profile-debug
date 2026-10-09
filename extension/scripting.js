/**
 * Fallback page driver built on chrome.scripting.
 *
 * Chrome refuses chrome.debugger on any tab that hosts a frame belonging to
 * another extension ("Cannot access a chrome-extension:// URL of different
 * extension"). Password managers inject exactly such a frame into most login and
 * form pages, so without a fallback those pages cannot be driven at all.
 *
 * This driver covers the same methods with page-side functions. It is weaker
 * than CDP and says so where it matters: events it dispatches are untrusted
 * (isTrusted === false), key presses only emulate the few default actions a form
 * needs, page.evaluate obeys the page's Content-Security-Policy, and screenshots
 * only work on the tab that is visible in its window. Console and network
 * buffers do not exist without the debugger.
 *
 * Every function passed to executeScript is serialised on its own, so each one
 * must be self-contained: no imports, no closures, no shared helpers.
 */

const BLOCKED_BY_EXTENSION = /chrome-extension:\/\/ URL of different extension/i;

/** True when Chrome refused the debugger because of another extension's frame. */
export function isBlockedByOtherExtension(error) {
  return BLOCKED_BY_EXTENSION.test(error?.message ?? String(error ?? ''));
}

/** Runs one self-contained function in the tab's top frame. */
async function run(tabId, func, args = [], world = 'ISOLATED') {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args
  });
  if (!injection) throw new Error(`Script did not run in tab ${tabId}`);
  if (injection.error) throw new Error(String(injection.error.message ?? injection.error));
  const outcome = injection.result;
  if (outcome?.error) throw new Error(outcome.error);
  return outcome?.value;
}

export function evaluate(tabId, expression, awaitPromise) {
  return run(tabId, pageEvaluate, [expression, awaitPromise], 'MAIN');
}

export function text(tabId, maxChars) {
  return run(tabId, pageText, [maxChars]);
}

export function readTree(tabId, interactiveOnly, maxNodes, interactiveRoles) {
  return run(tabId, pageReadTree, [interactiveOnly, maxNodes, interactiveRoles]);
}

export function click(tabId, x, y, button, clickCount) {
  return run(tabId, pageClick, [x, y, button, clickCount]);
}

export function type(tabId, value) {
  return run(tabId, pageType, [value]);
}

export function key(tabId, name, modifiers) {
  return run(tabId, pageKey, [name, modifiers]);
}

export function scroll(tabId, x, y, deltaX, deltaY) {
  return run(tabId, pageScroll, [x, y, deltaX, deltaY]);
}

export async function screenshot(tabId, format, quality) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    throw new Error('Screenshots without the debugger need the tab to be active: call tabs.activate first');
  }
  const options = { format: format === 'jpeg' ? 'jpeg' : 'png' };
  if (format === 'jpeg' && quality != null) options.quality = quality;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
  const size = await run(tabId, () => ({ value: { width: innerWidth, height: innerHeight } }));
  return { dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), ...size };
}

/* ------------------------------------------------- page-side functions */

async function pageEvaluate(expression, awaitPromise) {
  try {
    let value = (0, eval)(expression);
    if (awaitPromise) value = await value;
    try {
      return { value: JSON.parse(JSON.stringify(value) ?? 'null') };
    } catch {
      return { value: String(value) };
    }
  } catch (error) {
    const blocked = error instanceof EvalError || /Content Security Policy/i.test(String(error));
    return {
      error: blocked
        ? `This page's Content-Security-Policy forbids eval and the debugger is unavailable here: ${error}`
        : String(error?.stack ?? error)
    };
  }
}

function pageText(maxChars) {
  const value = document.body ? document.body.innerText : '';
  return { value: { text: value.slice(0, maxChars), truncated: value.length > maxChars } };
}

function pageReadTree(interactiveOnly, maxNodes, interactiveRoles) {
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role],[contenteditable=""],'
    + '[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  const EXTRA = 'h1,h2,h3,h4,h5,h6,img[alt],label';
  const TAG_ROLES = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    IMG: 'image', LABEL: 'LabelText'
  };
  const INPUT_ROLES = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox',
    button: 'button', submit: 'button', reset: 'button', image: 'button'
  };
  const roleOf = (el) => el.getAttribute('role')
    || (el.tagName === 'INPUT' ? INPUT_ROLES[el.type] ?? 'textbox' : TAG_ROLES[el.tagName])
    || (el.isContentEditable ? 'textbox' : 'generic');
  const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const nameOf = (el) => clean(el.getAttribute('aria-label'))
    || clean([...(el.labels ?? [])].map((label) => label.innerText).join(' '))
    || clean(el.getAttribute('alt'))
    || clean(el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) ? el.value : '')
    || clean(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.innerText)
    || clean(el.getAttribute('placeholder'))
    || clean(el.getAttribute('title'));
  const valueOf = (el) => {
    if (el.type === 'password') return null;
    if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
    return 'value' in el && el.tagName !== 'BUTTON' ? String(el.value) : null;
  };
  const boxOf = (el) => {
    const rect = el.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const right = Math.min(rect.right, innerWidth);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, innerHeight);
    if (right <= left || bottom <= top) return null;
    return {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  };

  const selector = interactiveOnly ? INTERACTIVE : `${INTERACTIVE},${EXTRA}`;
  const nodes = [];
  for (const el of document.querySelectorAll(selector)) {
    if (nodes.length >= maxNodes) break;
    if (el.getClientRects().length === 0 || el.closest('[aria-hidden="true"],[inert]')) continue;
    const role = roleOf(el);
    if (interactiveOnly && !interactiveRoles.includes(role.toLowerCase())) continue;
    const name = nameOf(el);
    if (!interactiveOnly && !name && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) continue;
    nodes.push({
      ref: `ref_${nodes.length + 1}`,
      role,
      name,
      value: valueOf(el),
      backendDOMNodeId: null,
      box: boxOf(el)
    });
  }
  return { value: nodes };
}

function pageClick(x, y, button, clickCount) {
  let target = document.elementFromPoint(x, y);
  while (target?.shadowRoot) {
    const inner = target.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === target) break;
    target = inner;
  }
  if (!target) return { error: `Nothing at (${x}, ${y}) in the viewport` };

  const code = { left: 0, middle: 1, right: 2 }[button];
  const mask = { left: 1, middle: 4, right: 2 }[button];
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  const fire = (Type, type, buttons, detail) =>
    target.dispatchEvent(new Type(type, { ...init, button: code, buttons, detail, pointerType: 'mouse' }));

  for (let count = 1; count <= clickCount; count += 1) {
    fire(PointerEvent, 'pointerdown', mask, count);
    const proceed = fire(MouseEvent, 'mousedown', mask, count);
    const focusable = target.closest('input,textarea,select,button,a[href],[tabindex],[contenteditable]');
    if (proceed && focusable) focusable.focus();
    fire(PointerEvent, 'pointerup', 0, count);
    fire(MouseEvent, 'mouseup', 0, count);
    fire(MouseEvent, button === 'right' ? 'contextmenu' : button === 'middle' ? 'auxclick' : 'click', 0, count);
  }
  if (clickCount === 2 && button === 'left') fire(MouseEvent, 'dblclick', 0, 2);
  return { value: { ok: true } };
}

function pageType(value) {
  const activeElement = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'];
  const insert = (el, chunk) => {
    if (document.execCommand('insertText', false, chunk)) return true;
    const isText = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TEXT.includes(el.type));
    if (!isText) return false;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + chunk + el.value.slice(end);
    // The prototype's setter bypasses the instance property React installs, so
    // React sees the change on the input event below instead of swallowing it.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, next);
    try {
      el.setSelectionRange(start + chunk.length, start + chunk.length);
    } catch {
      // email and number inputs have no selection API
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: chunk }));
    return true;
  };
  const focusNext = (from) => {
    const all = [...document.querySelectorAll(
      'input:not([type=hidden]),textarea,select,button,a[href],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
    )].filter((el) => !el.disabled && el.getClientRects().length > 0);
    all[(all.indexOf(from) + 1) % all.length]?.focus();
  };

  for (const segment of value.split(/(\n|\t)/)) {
    if (segment === '') continue;
    const el = activeElement();
    if (!el || el === document.body) return { error: 'No element has focus: click the field first' };
    if (segment === '\t') {
      focusNext(el);
    } else if (segment === '\n') {
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) insert(el, '\n');
      else el.form?.requestSubmit();
    } else if (!insert(el, segment)) {
      return { error: `The focused <${el.tagName.toLowerCase()}> does not accept text` };
    }
  }
  return { value: { ok: true } };
}

function pageKey(name, modifiers) {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  el = el ?? document.body;

  const key = name === 'Space' ? ' ' : name;
  const flags = {
    altKey: Boolean(modifiers & 1),
    ctrlKey: Boolean(modifiers & 2),
    metaKey: Boolean(modifiers & 4),
    shiftKey: Boolean(modifiers & 8)
  };
  const init = { key, bubbles: true, cancelable: true, composed: true, ...flags };
  let proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
  if (proceed && (key === 'Enter' || ([...key].length === 1 && !flags.ctrlKey && !flags.metaKey))) {
    proceed = el.dispatchEvent(new KeyboardEvent('keypress', init));
  }
  if (proceed) {
    const command = flags.ctrlKey || flags.metaKey;
    const editable = el.isContentEditable || 'value' in el;
    if (command && key.toLowerCase() === 'a') {
      if (el.select) el.select();
      else document.execCommand('selectAll');
    } else if (key === 'Enter') {
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) document.execCommand('insertText', false, '\n');
      else if (el.form) el.form.requestSubmit();
      else if (el.tagName === 'BUTTON' || el.tagName === 'A') el.click();
    } else if (key === 'Backspace' && editable) {
      document.execCommand('delete');
    } else if (key === 'Delete' && editable) {
      document.execCommand('forwardDelete');
    } else if (key === ' ' && (el.tagName === 'BUTTON' || ['checkbox', 'radio'].includes(el.type))) {
      el.click();
    } else if ([...key].length === 1 && !command && !flags.altKey && editable) {
      document.execCommand('insertText', false, key);
    } else if (key === 'Escape') {
      el.blur?.();
    }
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { value: { ok: true } };
}

function pageScroll(x, y, deltaX, deltaY) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    const style = getComputedStyle(el);
    const scrollsY = deltaY && /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const scrollsX = deltaX && /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    if (scrollsY || scrollsX) break;
    el = el.parentElement;
  }
  (el && el !== document.documentElement ? el : document.scrollingElement ?? document.documentElement)
    .scrollBy(deltaX, deltaY);
  return { value: { ok: true } };
}
