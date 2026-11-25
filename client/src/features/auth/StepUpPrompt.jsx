import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setStepUpHandler } from '../../services/api.js';
import { Button, Field, Modal } from '../../components/ui.jsx';
import { toAsciiDigits } from '../../utils/format.js';

/**
 * Identity check before a sensitive action (phase 3 step-up). Mounted once
 * for the whole app: when the server answers STEP_UP_REQUIRED, this asks
 * for the authenticator code (admin with 2FA) or the password, confirms it
 * with POST /auth/step-up, and the original request is sent again.
 */
export function StepUpPrompt() {
  const [request, setRequest] = useState(null); // { details, resolve }
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const pendingRequest = useRef(null);

  useEffect(() => {
    setStepUpHandler(
      (details) =>
        new Promise((resolve) => {
          // A second prompt while one is open: refuse it (the first one wins).
          if (pendingRequest.current) return resolve(false);
          pendingRequest.current = { details, resolve };
          setValue('');
          setError('');
          setRequest(pendingRequest.current);
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  const finish = useCallback((ok) => {
    pendingRequest.current?.resolve(ok);
    pendingRequest.current = null;
    setRequest(null);
  }, []);

  if (!request) return null;
  const totp = request.details.method === 'totp';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const entered = totp ? toAsciiDigits(value.trim()) : value;
    if (!entered) {
      setError(totp ? 'أدخل الكود المكوّن من 6 أرقام' : 'أدخل كلمة المرور');
      return;
    }
    setPending(true);
    try {
      await api.post('/auth/step-up', { action: request.details.action, ...(totp ? { code: entered } : { password: entered }) });
      finish(true);
    } catch (err) {
      setError(err.message);
      if (err.status === 401 && err.code !== 'STEP_UP_INVALID' && err.code !== 'MFA_CODE_REUSED') finish(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      size="sm"
      title="تأكيد الهوية"
      onClose={() => finish(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => finish(false)} disabled={pending}>
            إلغاء
          </Button>
          <Button type="submit" form="step-up-form" loading={pending}>
            تأكيد
          </Button>
        </>
      }
    >
      <form id="step-up-form" onSubmit={submit} noValidate>
        <p className="confirm__message">
          {totp
            ? 'هذا إجراء حساس. اكتب الكود الظاهر الآن في تطبيق المصادقة.'
            : 'هذا إجراء حساس. اكتب كلمة المرور الخاصة بحسابك للمتابعة.'}
        </p>
        <Field label={totp ? 'كود التطبيق' : 'كلمة المرور'} required error={error}>
          {(id) => (
            <input
              id={id}
              className="input"
              dir="ltr"
              type={totp ? 'text' : 'password'}
              inputMode={totp ? 'numeric' : undefined}
              autoComplete={totp ? 'one-time-code' : 'current-password'}
              maxLength={totp ? 6 : 200}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}
