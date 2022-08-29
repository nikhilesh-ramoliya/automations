const { signupUser, signinUser } = require("./users.model");
const { sendMail } = require("../../utils/sendmail");
const { generateToken } = require("../../utils/jwt-utils");
const fs = require("fs");
const util = require("util");
const unlinkFile = util.promisify(fs.unlink);
const { uploadFile } = require("../../utils/s3");
const reader = require("xlsx");

const signup = async (req, res) => {
  const signupRes = await signupUser(req.body);
  res.status(201).json(signupRes);
};

const signin = async (req, res) => {
  const userData = await signinUser(req.body);
  const token = await generateToken({ userData });
  res.cookie("jwtToken", token, {
    expires: new Date(Date.now() + 1000 * 60 * 600),
    httpOnly: true,
    sameSite: "none",
    secure: true,
  });
  res.status(200).json({ message: "signin successfully" });
};

const sendMailData = async (req, res) => {
  const email = req.user.userData.email;
  const isEmailSend = await sendMail(email, "sampleMail.hbs");
  if (isEmailSend) {
    res.status(200).json({ message: "message send" });
  }
};

const uploadImageData = async (req, res) => {
  const file = req.file;
  // const uploadFileRes = await uploadFile(req.file);
  // await unlinkFile(file.path);
  res.status(200).json({ message: "image uploaded" });
};

const sendSalarySleep = async (req, res) => {
  const salaryFile = req.file;
  const file = reader.readFile(salaryFile.path);
  let data = [];

  const sheets = file.SheetNames;

  for (let i = 0; i < sheets.length; i++) {
    const temp = reader.utils.sheet_to_json(file.Sheets[file.SheetNames[i]]);
    temp.forEach((res) => {
      data.push(res);
    });
  }

  // Printing data
  console.log({ data });
};

module.exports = {
  signup,
  signin,
  sendMailData,
  uploadImageData,
  sendSalarySleep,
};
