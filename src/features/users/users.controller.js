const { signupUser, signinUser } = require("./users.model");
const { sendMail } = require("../../utils/sendMail-utils");
const { generateToken } = require("../../utils/jwt-utils");
const Handlebars = require("handlebars");
const path = require("path");
const fs = require("fs");
const util = require("util");
const unlinkFile = util.promisify(fs.unlink);
const { uploadFile } = require("../../utils/s3");
const { runInNewContext } = require("vm");

const signup = async (req, res) => {
  try {
    const signupRes = await signupUser(req.body, res);
    signupRes
      ? res.status(signupRes.status).json(signupRes)
      : res.status(400).json({ error: "something went wrong" });
  } catch (err) {
    console.log({ err });
  }
};

const signin = async (req, res) => {
  try {
    const data = await signinUser(req.body);
    if (data.isValid) {
      const token = await generateToken({ userData: data.userData });
      res.cookie("jwtToken", token, {
        expires: new Date(Date.now() + 1000 * 60 * 600),
        httpOnly: true,
        sameSite: "none",
        secure: true,
      });
      res.status(200).json({ message: "signin successfully", token });
    } else {
      res.status(400).json({ message: "Invalid details" });
    }
  } catch (err) {
    console.log({ err });
  }
};

const sendMailData = async (req, res) => {
  try {
    const email = req.user.userData.email;
    const title = "Sample mail ";
    const subjectData = "Sample mail";
    const text = "Confirm";
    const source = await fs.readFileSync(
      path.join(__dirname, "../../template/sampleMail.hbs"),
      "utf-8"
    );
    const template = await Handlebars.compile(source);
    const { transporter, messageData } = await sendMail(
      email,
      title,
      subjectData,
      text,
      template
    );
    transporter.sendMail(messageData, function (err, info) {
      if (err) {
        console.log(err);
        res.status(400).json({ error: "something went wrong" });
      } else {
        // console.log(info);
        res.status(200).json({ message: "email sent" });
      }
    });
  } catch (err) {
    console.log({ err });
  }
};

const uploadImageData = async (req, res) => {
  try {
    const file = req.file;
    // const uploadFileRes = await uploadFile(req.file);
    // await unlinkFile(file.path);
    res.status(200).json({ message: "image uploaded" });
  } catch (err) {
    console.log({ err });
  }
};
module.exports = { signup, signin, sendMailData, uploadImageData };
