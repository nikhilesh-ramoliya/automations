const nodemailer = require("nodemailer");

const sendMail = async (email, title, subjectData, text, template) => {
  try {
    let transporter = nodemailer.createTransport({
      service: "gmail",
      host: process.env.EMAIL_HOST,
      //   port: process.env.EMAIL_PORT,
      //   secure: false,
      //   name: process.env.EMAIL_NAME,
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
    const resMail = await transporter.sendMail(
      messageData,
      function (err, info) {
        if (err) {
          console.log(err);
        } else {
          // console.log(info);
        }
      }
    );
    if (resMail) {
      return;
    }
  } catch (err) {
    console.log(err);
  }
};

module.exports = { sendMail };
