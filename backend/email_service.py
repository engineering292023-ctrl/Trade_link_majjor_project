"""
TRADELINK — Email Service  (backend/email_service.py)

Sends transactional emails using Gmail SMTP — completely free.

EMAILS WE SEND:
1. Email verification  — after registration, confirm the email is real
2. Password reset      — when user clicks "Forgot Password"
3. KYC approved        — notify seller/merchant their KYC was approved
4. KYC rejected        — notify with reason

WHY GMAIL SMTP?
- Free (uses your Gmail account)
- No external service needed
- Works immediately
- 500 emails/day limit is more than enough for development

SETUP (one time):
1. Use a Gmail account (create one like: tradelink.noreply@gmail.com)
2. Enable 2-Factor Authentication on that Gmail
3. Go to Google Account → Security → App Passwords
4. Generate an App Password for "Mail"
5. Put that 16-character password in .env as GMAIL_APP_PASSWORD
"""

import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from config import settings


def send_via_mailjet(to_email: str, subject: str, html_body: str) -> bool:
    """Sends email via Mailjet REST API v3.1."""
    api_key = settings.MAILJET_API_KEY
    api_secret = settings.MAILJET_API_SECRET
    sender = settings.MAILJET_SENDER_EMAIL or "noreply@tradelink.com"
    if not api_key or not api_secret:
        return False

    try:
        import requests
        url = "https://api.mailjet.com/v3.1/send"
        payload = {
            "Messages": [
                {
                    "From": {
                        "Email": sender,
                        "Name": "TradeLink"
                    },
                    "To": [
                        {
                            "Email": to_email,
                            "Name": to_email.split("@")[0]
                        }
                    ],
                    "Subject": subject,
                    "HTMLPart": html_body
                }
            ]
        }
        res = requests.post(url, json=payload, auth=(api_key, api_secret), timeout=10)
        if res.status_code == 200:
            print(f"✅ Mailjet email sent to {to_email}: {subject}")
            return True
        else:
            print(f"❌ Mailjet email error ({res.status_code}): {res.text}")
            return False
    except Exception as e:
        print(f"⚠️ Mailjet email exception for {to_email}: {e}")
        return False


def send_via_appscript(to_email: str, subject: str, html_body: str) -> bool:
    """Sends email by posting to deployed Google Apps Script Web App URL."""
    if not settings.APPSCRIPT_EMAIL_URL:
        return False
    try:
        import urllib.request
        import json
        payload = json.dumps({
            "to": to_email,
            "subject": subject,
            "body": html_body
        }).encode("utf-8")

        req = urllib.request.Request(
            settings.APPSCRIPT_EMAIL_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=12) as response:
            res_data = response.read().decode("utf-8")
            print(f"✅ AppsScript Email sent to {to_email}: {subject}")
            return True
    except Exception as e:
        print(f"⚠️ AppsScript Email failed for {to_email}: {e}")
        return False


def send_email(to_email: str, subject: str, html_body: str) -> bool:
    """
    Sends an HTML email.
    Priority: 1) Mailjet REST API -> 2) Google AppsScript -> 3) Gmail SMTP
    """
    if settings.MAILJET_API_KEY and settings.MAILJET_API_SECRET:
        if send_via_mailjet(to_email, subject, html_body):
            return True

    if settings.APPSCRIPT_EMAIL_URL:
        if send_via_appscript(to_email, subject, html_body):
            return True

    if not settings.GMAIL_ADDRESS or not settings.GMAIL_APP_PASSWORD:
        print(f"⚠️  Email not configured. Would have sent to {to_email}: {subject}")
        print("   Set MAILJET_API_KEY, APPSCRIPT_EMAIL_URL or GMAIL_ADDRESS in .env to enable emails.")
        return False

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = f"TradeLink <{settings.GMAIL_ADDRESS}>"
        msg["To"]      = to_email

        # Attach HTML part
        msg.attach(MIMEText(html_body, "html"))

        # Send via Gmail SMTP (port 587 = TLS)
        context = ssl.create_default_context()
        with smtplib.SMTP("smtp.gmail.com", 587) as server:
            server.ehlo()
            server.starttls(context=context)
            server.login(settings.GMAIL_ADDRESS, settings.GMAIL_APP_PASSWORD)
            server.sendmail(settings.GMAIL_ADDRESS, to_email, msg.as_string())

        print(f"✅ Email sent to {to_email}: {subject}")
        return True

    except Exception as e:
        print(f"❌ Email failed to {to_email}: {e}")
        return False


# ─────────────────────────────────────────
# EMAIL TEMPLATES
# ─────────────────────────────────────────

def _base_template(title: str, content: str) -> str:
    """Wraps email content in a consistent HTML template."""
    return f"""
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:white;border-radius:12px;
              overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#1a6b3a;padding:28px 32px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="background:rgba(255,255,255,0.2);border-radius:10px;
                    padding:8px 14px;font-weight:800;font-size:18px;color:white;">
          TL
        </div>
        <div>
          <div style="color:white;font-size:20px;font-weight:700;">TradeLink</div>
          <div style="color:rgba(255,255,255,0.7);font-size:12px;">Sell Direct. Earn More.</div>
        </div>
      </div>
    </div>

    <!-- Body -->
    <div style="padding:32px;">
      <h2 style="margin:0 0 16px;color:#111827;font-size:22px;">{title}</h2>
      {content}
    </div>

    <!-- Footer -->
    <div style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;">
        TradeLink · B2B Marketplace · India<br>
        You received this because you have an account on TradeLink.
      </p>
    </div>
  </div>
</body>
</html>
"""


def send_verification_email(to_email: str, name: str, verify_link: str) -> bool:
    """
    Sent after registration — user must click link to verify their email.
    The verify_link comes from Firebase Auth (generated by generate_email_verification_link).
    """
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      Welcome to TradeLink! Please verify your email address to activate your account
      and start using all features.
    </p>

    <div style="text-align:center;margin:28px 0;">
      <a href="{verify_link}"
         style="background:#1a6b3a;color:white;padding:14px 32px;border-radius:8px;
                text-decoration:none;font-weight:600;font-size:15px;
                display:inline-block;">
        ✓ Verify My Email →
      </a>
    </div>

    <p style="color:#6b7280;font-size:13px;">
      This link expires in 24 hours. If you didn't create a TradeLink account,
      you can safely ignore this email.
    </p>
    """
    return send_email(to_email, "Verify your TradeLink email", _base_template("Verify Your Email", content))


def send_password_reset_email(to_email: str, name: str, reset_link: str) -> bool:
    """
    Sent when user clicks "Forgot Password".
    The reset_link comes from Firebase Auth.
    """
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      We received a request to reset your TradeLink password.
      Click the button below to create a new password.
    </p>

    <div style="text-align:center;margin:28px 0;">
      <a href="{reset_link}"
         style="background:#1a6b3a;color:white;padding:14px 32px;border-radius:8px;
                text-decoration:none;font-weight:600;font-size:15px;display:inline-block;">
        Reset My Password →
      </a>
    </div>

    <p style="color:#6b7280;font-size:13px;">
      This link expires in 1 hour. If you didn't request a password reset,
      you can safely ignore this email — your password won't change.
    </p>
    """
    return send_email(to_email, "Reset your TradeLink password", _base_template("Reset Your Password", content))


def send_kyc_approved_email(to_email: str, name: str) -> bool:
    """Sent when admin approves a user's KYC documents."""
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      Great news! Your KYC documents have been verified and your account is now
      fully activated.
    </p>

    <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;
                padding:16px 20px;margin:20px 0;">
      <p style="margin:0;color:#15803d;font-weight:600;">✅ Your account is now verified</p>
      <p style="margin:4px 0 0;color:#166534;font-size:13px;">
        You can now receive payments, post listings, and use all features.
      </p>
    </div>

    <p style="color:#374151;font-size:14px;">Log in to get started:</p>
    <div style="text-align:center;margin:20px 0;">
      <a href="http://localhost:5500/seller-portal/index.html"
         style="background:#1a6b3a;color:white;padding:12px 28px;border-radius:8px;
                text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">
        Go to Dashboard →
      </a>
    </div>
    """
    return send_email(to_email, "✅ Your KYC is approved — TradeLink", _base_template("KYC Approved!", content))


def send_kyc_rejected_email(to_email: str, name: str, reason: str) -> bool:
    """Sent when admin rejects KYC with a reason."""
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      We reviewed your KYC documents and unfortunately could not verify them.
    </p>

    <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;
                padding:16px 20px;margin:20px 0;">
      <p style="margin:0;color:#dc2626;font-weight:600;">❌ Reason for rejection:</p>
      <p style="margin:6px 0 0;color:#991b1b;font-size:14px;">{reason}</p>
    </div>

    <p style="color:#374151;font-size:14px;line-height:1.6;">
      Please log in, go to <strong>Profile &amp; KYC</strong>,
      and re-upload your documents addressing the reason above.
      Your account remains active but payments will be on hold until KYC is approved.
    </p>
    """
    return send_email(to_email, "Action needed — KYC documents", _base_template("KYC Update Required", content))

def send_otp_email(to_email: str, name: str, otp: str, role: str) -> bool:
    """
    Sends a beautiful HTML email with the 6-digit OTP.
    Called when user registers with email/password.
    Google sign-in users skip this — Google already verified their email.

    The email includes:
    - Large OTP digits (easy to read)
    - 10-minute expiry warning
    - Role-specific message (seller vs merchant)
    - Security note
    """
    role_color = "#1a6b3a" if role == "seller" else "#1d4ed8"
    role_label = "Seller" if role == "seller" else "Buyer / Merchant"
    role_desc  = (
        "Post listings, receive bids, and get paid directly."
        if role == "seller"
        else "Browse listings, place bids, and buy directly from producers."
    )

    # Split OTP into individual digits for big display
    otp_digits = "".join(
        f'<span style="display:inline-block;background:#f3f4f6;border:2px solid #e5e7eb;'        f'border-radius:8px;padding:12px 16px;margin:0 4px;font-family:monospace;'        f'font-size:32px;font-weight:800;color:{role_color};">{d}</span>'
        for d in str(otp)
    )

    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      Welcome to TradeLink! You're registering as a
      <strong style="color:{role_color};">{role_label}</strong>.
      {role_desc}
    </p>

    <p style="color:#374151;font-size:14px;margin-top:16px;">
      Your email verification code is:
    </p>

    <!-- OTP DIGITS — big and clear -->
    <div style="text-align:center;margin:24px 0 8px;">
      {otp_digits}
    </div>

    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-bottom:24px;">
      ⏱ This code expires in <strong>10 minutes</strong>
    </p>

    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;
                padding:14px 18px;margin-bottom:16px;">
      <p style="margin:0;color:#92400e;font-size:13px;">
        🔒 <strong>Security note:</strong> Enter this code only on the TradeLink website.
        We will never ask for your OTP via phone or chat.
        If you didn't register on TradeLink, ignore this email.
      </p>
    </div>

    <p style="color:#6b7280;font-size:13px;">
      Go back to the TradeLink registration page and enter the 6-digit code above.
    </p>
    """

    subject = f"Your TradeLink verification code: {otp}"
    return send_email(to_email, subject, _base_template(f"Verify Your Email — {otp}", content))


def send_password_reset_otp_email(to_email: str, name: str, otp: str) -> bool:
    """Sends OTP email specifically for password reset (not registration)."""
    otp_digits = "".join(
        f'<span style="display:inline-block;background:#f3f4f6;border:2px solid #e5e7eb;'
        f'border-radius:8px;padding:12px 16px;margin:0 4px;font-family:monospace;'
        f'font-size:32px;font-weight:800;color:#1a6b3a;">{d}</span>'
        for d in str(otp)
    )
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      We received a request to reset your TradeLink password.
      Use the code below to set a new password.
    </p>
    <p style="color:#374151;font-size:14px;margin-top:16px;">Your password reset code is:</p>
    <div style="text-align:center;margin:24px 0 8px;">
      {otp_digits}
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-bottom:24px;">
      ⏱ This code expires in <strong>10 minutes</strong>
    </p>
    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;
                padding:14px 18px;margin-bottom:16px;">
      <p style="margin:0;color:#92400e;font-size:13px;">
        🔒 If you did not request a password reset, ignore this email.
        Your password will not change.
      </p>
    </div>
    <p style="color:#6b7280;font-size:13px;">
      Go back to TradeLink and enter the 6-digit code above.
    </p>
    """
    subject = f"Your TradeLink password reset code: {otp}"
    return send_email(to_email, subject, _base_template(f"Reset Password — {otp}", content))

def send_reset_otp_email(to_email: str, name: str, otp: str) -> bool:
    """Sends a 6-digit OTP for password reset."""
    otp_digits = "".join(
        f'<span style="display:inline-block;background:#f3f4f6;border:2px solid #e5e7eb;'
        f'border-radius:8px;padding:12px 16px;margin:0 4px;font-family:monospace;'
        f'font-size:32px;font-weight:800;color:#1a6b3a;">{d}</span>'
        for d in str(otp)
    )
    content = f"""
    <p style="color:#374151;font-size:15px;line-height:1.6;">
      Hi <strong>{name}</strong>,<br><br>
      We received a request to reset your TradeLink password.
      Enter the code below in the app to set a new password.
    </p>
    <p style="color:#374151;font-size:14px;margin-top:16px;">Your password reset code:</p>
    <div style="text-align:center;margin:24px 0 8px;">
      {otp_digits}
    </div>
    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-bottom:24px;">
      ⏱ Expires in <strong>10 minutes</strong>
    </p>
    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;
                padding:14px 18px;margin-bottom:16px;">
      <p style="margin:0;color:#92400e;font-size:13px;">
        🔒 If you did not request this, ignore this email — your password will not change.
      </p>
    </div>
    """
    return send_email(
        to_email,
        f"🔑 Your TradeLink password reset code: {otp}",
        _base_template("Reset Your Password", content)
    )