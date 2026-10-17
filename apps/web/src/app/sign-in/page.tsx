import { SignInForm } from '@/components/SignInForm';

export const metadata = { title: 'Sign in · Exam App' };

export default function SignInPage() {
  return (
    <>
      <ol className="steps" aria-label="Progress">
        <li className="current" /><li /><li /><li />
      </ol>
      <h1>Sign in or create your account</h1>
      <p className="muted">One step. We'll email or text you a one-time code.</p>
      <SignInForm />
    </>
  );
}
