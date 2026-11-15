import { Alert, Button, ConfigProvider, Form, Input, Spin } from 'antd';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApiError, getSession, login, logout, type AdminSession, type Credentials } from './session';
import { Workbench } from './workbench';
import './style.css';

function SignInFrame({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh">
      <header className="px-6 py-6 text-lg font-semibold sm:px-8">花火</header>
      <div className="mx-auto mt-12 w-full max-w-[408px] px-6 pb-12 sm:mt-20">{children}</div>
    </main>
  );
}

function loginError(error: unknown) {
  if (error instanceof AdminApiError) {
    if (error.status === 401) return '用户名或密码不正确。';
    if (error.status === 429) return '登录尝试过于频繁，请稍后再试。';
    if (error.code === 'CSRF_ORIGIN_INVALID') return '请通过配置的管理后台地址登录。';
  }
  return '暂时无法登录，请稍后再试。';
}

function SignIn({ onSignedIn }: { onSignedIn: (session: AdminSession) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(credentials: Credentials) {
    setSubmitting(true);
    setError(undefined);
    try {
      onSignedIn(await login({ ...credentials, username: credentials.username.trim() }));
    } catch (cause) {
      setError(loginError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SignInFrame>
      <h1 className="mb-8 text-[30px] leading-tight font-semibold tracking-tight">管理员登录</h1>
      {error && <Alert className="mb-4" type="error" showIcon title={error} />}
      <Form<Credentials> layout="vertical" requiredMark={false} onFinish={submit}>
        <Form.Item name="username" label="用户名" rules={[{ required: true, whitespace: true, message: '请输入用户名。' }]}>
          <Input autoComplete="username" maxLength={64} size="large" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码。' }]}>
          <Input.Password autoComplete="current-password" maxLength={128} size="large" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={submitting}>登录</Button>
      </Form>
    </SignInFrame>
  );
}

type SessionState = { kind: 'loading' | 'unavailable' | 'signed-out' } | { kind: 'signed-in'; session: AdminSession };

function AdminApp() {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();

  const sessionExpired = useCallback(() => setState({ kind: 'signed-out' }), []);

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(
      session => { if (!controller.signal.aborted) setState({ kind: 'signed-in', session }); },
      cause => {
        if (controller.signal.aborted) return;
        setState({ kind: cause instanceof AdminApiError && cause.status === 401 ? 'signed-out' : 'unavailable' });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  async function signOut(session: AdminSession) {
    setLoggingOut(true);
    setError(undefined);
    try {
      await logout(session.csrfToken);
      setState({ kind: 'signed-out' });
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 401) setState({ kind: 'signed-out' });
      else setError('暂时无法退出，请重试。');
    } finally {
      setLoggingOut(false);
    }
  }

  if (state.kind === 'signed-in') {
    return <Workbench admin={state.session.admin} csrfToken={state.session.csrfToken} onLogout={() => void signOut(state.session)} loggingOut={loggingOut} error={error} onSessionExpired={sessionExpired} />;
  }
  if (state.kind === 'signed-out') {
    return <SignIn onSignedIn={session => setState({ kind: 'signed-in', session })} />;
  }
  if (state.kind === 'unavailable') {
    return (
      <SignInFrame>
        <Alert type="error" showIcon title="暂时无法连接管理后台。" />
        <Button className="mt-4" onClick={() => {
          setState({ kind: 'loading' });
          setAttempt(current => current + 1);
        }}>重试</Button>
      </SignInFrame>
    );
  }
  return <SignInFrame><p role="status" className="flex items-center gap-3 text-sm text-slate-600"><Spin size="small" />正在检查登录状态</p></SignInFrame>;
}

const preview = import.meta.env.DEV && import.meta.env.MODE === 'demo';
const root = document.getElementById('root');
if (!root) throw new Error('Admin UI root is missing');

createRoot(root).render(
  <ConfigProvider theme={{
    token: { colorPrimary: '#171717', colorText: '#171717', colorTextSecondary:'#575757', colorTextPlaceholder: '#575757', colorBorder: '#d4d4d4', colorBgLayout:'#fafafa', borderRadius: 8, controlHeight:40, controlHeightLG:48, controlHeightSM:32, fontSize:14, fontFamily: 'inherit' },
    components:{Button:{primaryShadow:'none',defaultShadow:'none',primaryColor:'#fafafa',colorPrimaryHover:'#373737',colorPrimaryActive:'#171717'},Input:{activeBorderColor:'#565656',hoverBorderColor:'#565656'}},
  }}>
    {preview ? <Workbench /> : <AdminApp />}
  </ConfigProvider>,
);
