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
