const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const sendMail = async (email, title, subjectData, text, template) => {
  try {
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

    // **** sending mail using outh2  ****
    const OAuth2Client = new google.auth.OAuth2(
      process.env.CLIENT_ID,
      process.env.CLIENT_SECRET,
      process.env.REDIRECT_URI
    );
    OAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
    const accessToken = await OAuth2Client.getAccessToken();

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
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
      subject: subjectData,
      text: text,
      html: template(),
    };

    return { transporter, messageData };
  } catch (err) {
    console.log(err);
  }
};

module.exports = { sendMail };
