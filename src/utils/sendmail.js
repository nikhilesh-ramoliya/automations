const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const Handlebars = require('handlebars');

/**
 * It will send mail
 * @param {object} params Object of email,template,subject,text
 * @returns email response data
 */
const sendMail = async ({
  email,
  template,
  subject = 'Sample mail',
  text = 'Confirm',
}) => {
  // **** sending mail using email and password ****
  // let transporter = nodemailer.createTransport({
  //   host: process.env.EMAIL_HOST,
  //   port: process.env.EMAIL_PORT,
  //   secure: true,
  //   name: process.env.EMAIL_NAME,
  //   auth: {
  //     user: process.env.SENDER_EMAIL,
  //     pass: process.env.EMAIL_PASSWORD,
  //   },
  // });

  const source = await fs.readFileSync(
    path.join(__dirname, `../template/${template}`),
    'utf-8'
  );
  const templateInstance = await Handlebars.compile(source);

  // **** sending mail using outh2  ****
  const OAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  OAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
  const accessToken = await OAuth2Client.getAccessToken();

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type: 'OAuth2',
      user: process.env.EMAIL,
      accessToken,
      clientId: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
      refreshToken: process.env.REFRESH_TOKEN,
    },
  });

  const messageData = {
    from: process.env.SENDER_EMAIL,
    to: email,
    subject,
    text,
    html: templateInstance(),
  };

  return new Promise((resolve) => {
    transporter.sendMail(messageData, (err, info) => {
      if (err) {
        console.log(err);
      } else {
        resolve(info);
      }
    });
  });
};

module.exports = { sendMail };
