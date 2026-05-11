import { Resend } from 'resend';
import { env } from '@/lib/env';

export async function sendEmail(args: { subject: string; markdown: string }): Promise<{ sent: boolean; reason?: string }> {
  if (!env.resendApiKey || !env.emailFrom || !env.emailTo) {
    return { sent: false, reason: 'RESEND_API_KEY, EMAIL_FROM, or EMAIL_TO missing' };
  }
  const resend = new Resend(env.resendApiKey);
  await resend.emails.send({
    from: env.emailFrom,
    to: env.emailTo,
    subject: args.subject,
    text: args.markdown
  });
  return { sent: true };
}
