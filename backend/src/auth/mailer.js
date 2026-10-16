export function createResetMailer({ resendApiKey, passwordResetFrom }, fetchImpl = fetch) {
  if (!resendApiKey || !passwordResetFrom) return undefined;
  return async ({ email, url }) => {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: passwordResetFrom, to: [email], subject: 'Reset your Noteway password',
        text: `Reset your password using this link:\n\n${url}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.` }),
    });
    if (!response.ok) throw new Error('Password reset email delivery failed.');
  };
}
