const { signupUser, signinUser } = require("./users.model");
const { sendMail } = require("../../utils/sendMail-utils");
const { generateToken } = require("../../utils/jwt-utils");
const Handlebars = require("handlebars");
const path = require("path");

const fs = require("fs");

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
    const email = "jimitmewada2@gmail.com";
    const title = "Sample mail ";
    const subjectData = "Sample mail";
    const text = "Confirm";
    const source = await fs.readFileSync(
      path.join(__dirname, "../../template/sampleMail.hbs"),
      "utf-8"
    );
    const template = await Handlebars.compile(source);
    const resEmail = await sendMail(email, title, subjectData, text, template);
    res.status(200).json({ message: "message sent" });
  } catch (err) {
    console.log({ err });
  }
};

const uploadImage = async (req, res) => {
  try {
    const file = req.file;
    console.log({ file });
  } catch (err) {
    console.log({ err });
  }
};
module.exports = { signup, signin, sendMailData, uploadImage };
