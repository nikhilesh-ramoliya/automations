const nodemailer = require("nodemailer");

const sendMail = async (email, title, subjectData, text, template) => {
  try {
    let transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: true,
      name: process.env.EMAIL_NAME,
      auth: {
        user: process.env.SENDER_EMAIL,
        pass: process.env.EMAIL_PASSWORD,
      },
    });
    const messageData = {
      from: process.env.SENDER_EMAIL,
      to: email,
      subject: subjectData,
      text: text,
      html: template(),
    };
    transporter.sendMail(messageData, function (err, info) {
      if (err) {
        console.log(err);
      } else {
        // console.log(info);
      }
    });
    return true;
  } catch (err) {
    console.log(err);
  }
};

module.exports = { sendMail };
