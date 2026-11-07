import { useState } from 'react';
import { Button, Field, Modal } from './ui.jsx';
import { useAction } from '../hooks/useAsync.js';

/**
 * Confirmation dialog for dashboard-wide actions. The admin has to type
 * `word` before the action runs, so a misclick can never trigger it.
 * `onConfirm(word)` may throw; its message is shown in the dialog.
 */
export function ConfirmWordModal({ open, title, word, confirmLabel, onClose, onConfirm, children }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const close = () => {
    setTyped('');
    setError('');
    onClose();
  };
  const [run, running] = useAction(async () => {
    setError('');
    try {
      await onConfirm(typed.trim());
      setTyped('');
    } catch (err) {
      setError(err.details?.[0]?.message || err.message);
    }
  });
  const ready = typed.trim() === word;

  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={running}>إلغاء</Button>
          <Button variant="danger" loading={running} disabled={!ready} onClick={run}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
      <Field label={`للتأكيد اكتب كلمة "${word}"`} required>
        {(id) => (
          <input
            id={id}
            className="input"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && !running && run()}
          />
        )}
      </Field>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}
