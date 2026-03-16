import nodemailer from 'nodemailer';
import 'dotenv/config';

/**
 * sendNotificationEmail
 * Sends a notification to Andrew Bluestone when a "colorable case" is detected.
 */
export async function sendNotificationEmail(userData) {
    const { question, analysis, history } = userData;

    // Check if we have credentials. If not, log and return (don't crash)
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.warn('⚠️  Email credentials missing in .env (SMTP_HOST, SMTP_USER, SMTP_PASS). Skipping email.');
        console.log('--- EMAIL MOCK ---');
        console.log(`To: ${process.env.NOTIFICATION_EMAIL || 'Andrew Bluestone'}`);
        console.log('Subject: 🚨 New Colorable Malpractice Case Detected');
        console.log(`User Question: ${question}`);
        console.log('--- END MOCK ---');
        return;
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '465'),
        secure: process.env.SMTP_PORT === '465',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    const mailOptions = {
        from: `"AI Malpractice Consultant" <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER,
        subject: '🚨 New Colorable Malpractice Case Detected',
        html: `
            <h2>New Potential Client Lead</h2>
            <p>Our AI has identified a user with a <strong>colorable legal malpractice case</strong> in New York.</p>
            
            <h3>Latest Question:</h3>
            <p><em>"${question}"</em></p>
            
            <h3>Diagnostic Inference:</h3>
            <div style="background: #f9f9f9; padding: 15px; border-left: 4px solid #dcb360;">
                ${analysis.replace(/\n/g, '<br>')}
            </div>
            
            <h3>Conversation History:</h3>
            <ul>
                ${history.map(m => `<li><strong>${m.role}:</strong> ${m.content.substring(0, 100)}...</li>`).join('')}
            </ul>
            
            <p><small>This notification was generated automatically by the Attorney Malpractice AI system.</small></p>
        `,
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Notification email sent:', info.messageId);
    } catch (error) {
        console.error('❌ Failed to send notification email:', error.message);
    }
}
