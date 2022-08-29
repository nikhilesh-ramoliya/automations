const {
  signup,
  signin,
  sendMailData,
  uploadImageData,
  sendSalarySleep,
} = require("./users.controller");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const { validateUserToken } = require("../../middleware/validateUser");
const {
  useErrorHandlingMiddleware,
} = require("../../middleware/errorHandling");

const initializeUsersService = (app) => {
  app.post("/api/signup", signup);
  app.post("/api/signin", useErrorHandlingMiddleware(signin));
  app.post("/api/sendmail", validateUserToken, sendMailData);
  app.post(
    "/api/uploadimage",
    validateUserToken,
    upload.single("image"),
    uploadImageData
  );
  app.post("/api/sendSalarySlip", upload.single("salaryData"), sendSalarySleep);
};

module.exports = { initializeUsersService };
