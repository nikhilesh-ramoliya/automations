const { signupUser, signinUser } = require("./users.service");
const { sendMail } = require("../../utils/sendmail");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const reader = require("xlsx");
const {
  validateUserToken,
  useErrorHandlingMiddleware,
} = require("../../middleware");

const signup = async (req, res) => {
  const { newUser } = await signupUser(req.body);
  res.status(201).json(newUser);
};

const signin = async (req, res) => {
  const { token } = await signinUser(req.body);
  res.cookie("jwtToken", token, {
    expires: new Date(Date.now() + 1000 * 60 * 600),
    httpOnly: true,
    sameSite: "none",
    secure: true,
  });
  res.json({ message: "SignIn Successful" });
};

const sendMailData = async (req, res) => {
  const { email } = req.user.userData;
  const isEmailSend = await sendMail(email, "sampleMail.hbs");
  if (isEmailSend) {
    res.json({ message: "Message Sent" });
  }
};

const uploadImageData = async (req, res) => {
  const file = req.file;
  // const uploadFileRes = await uploadFile(req.file);
  // await unlinkFile(file.path);
  res.json({ message: "Image Uploaded" });
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

const initializeUsersService = (app) => {
  app.post("/api/signup", useErrorHandlingMiddleware(signup));
  app.post("/api/signin", useErrorHandlingMiddleware(signin));
  app.post(
    "/api/sendmail",
    useErrorHandlingMiddleware(validateUserToken),
    useErrorHandlingMiddleware(sendMailData)
  );
  app.post(
    "/api/uploadimage",
    useErrorHandlingMiddleware(validateUserToken),
    upload.single("image"),
    useErrorHandlingMiddleware(uploadImageData)
  );
  app.post(
    "/api/sendSalarySlip",
    upload.single("salaryData"),
    useErrorHandlingMiddleware(sendSalarySleep)
  );
};

module.exports = { initializeUsersService };
