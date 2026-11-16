export function createSceneChatInput({ doc, text, send, mode, form, input, submit, feedback, delivered }) {
  let pending = null, retry = null, connected = false, blocked = false;
  const sync = () => {
    submit.disabled = !connected || blocked || !!pending || !input.value.trim();
    const label = pending ? text('发送中', 'Sending') : text('发送', 'Send');
    if (submit.textContent !== label) submit.textContent = label;
  };
  function note(message) { if (feedback.textContent !== message) feedback.textContent = message; }
  function failed() {
    if (!pending) return;
    clearTimeout(pending.timer);
    retry = pending;
    pending = null;
    note(text('未能确认发送，输入已保留。', 'Delivery was not confirmed. The draft is kept.'));
    sync();
  }
  input.addEventListener('input', () => { if (!pending && connected) note(''); sync(); });
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    form.requestSubmit();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (submit.disabled) return;
    const value = input.value, message = value.trim();
    const id = retry?.message === message ? retry.id : doc.defaultView.crypto.randomUUID();
    pending = { id, value, message, timer: setTimeout(failed, 8000) };
    if (!send({ t: 'phone-message', request: id, text: message, scene: mode })) { failed(); return; }
    note('');
    sync();
  });
  sync();
  return {
    setOnline(value) {
      if (value === connected) return;
      connected = value;
      if (!value) failed();
      else if (!pending && !retry) note('');
      sync();
    },
    setBlocked(value) { if (blocked !== !!value) { blocked = !!value; sync(); } },
    failed, note,
    receipt({ request, ok, cursor }) {
      const response = pending?.id === request ? pending : retry?.id === request ? retry : null;
      if (!response) return;
      if (pending?.id === request) pending = null;
      if (retry?.id === request) retry = null;
      clearTimeout(response.timer);
      if (ok) {
        if (input.value === response.value) input.value = '';
        delivered?.(response.message, cursor, request);
        note('');
      } else {
        note(text('发送失败，输入已保留。', 'Could not send. Your draft is kept.'));
      }
      sync();
    },
    sync,
    focus() { input.focus({ preventScroll:true }); },
  };
}

