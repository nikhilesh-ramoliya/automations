const { signupUser, signinUser } = require("./users.service");
const { sendMail } = require("../../utils/sendmail");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const reader = require("xlsx");
const {
  validateUserToken,
  useErrorHandlingMiddleware,
} = require("../../middleware");
const { EmailSendError } = require("../../error");
const dayjs = require("dayjs");

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
  const readOpts = {
    cellText: false,
    cellDates: true,
  };
  const file = reader.readFile(salaryFile.path, readOpts);
  let data = [];

  const sheets = file.SheetNames;

  for (let i = 0; i < sheets.length; i++) {
    const temp = reader.utils.sheet_to_json(file.Sheets[file.SheetNames[i]]);
    temp.forEach((res) => {
      data.push(res);
    });
  }

  let emailNotSendCounter = 0;
  for (let k = 0; k < data.length; k++) {
    data[k].Payslip_For_The_Month = dayjs(data[k].Payslip_For_The_Month).format(
      "DD/MM/YYYY"
    );
    data[k].Date_Of_Joining = dayjs(data[k].Date_Of_Joining).format(
      "DD/MM/YYYY"
    );
    console.log({ data: data[k] });
    let isSend = await sendMail(data[k]["Email"], "salaryslip.hbs", data[k]);
    if (!isSend) {
      emailNotSendCounter++;
    }
  }
  if (emailNotSendCounter === 0) {
    res.send({ message: "salary slip has been sent to all the employee" });
  } else {
    throw new EmailSendError("Something went while sending error");
  }
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
