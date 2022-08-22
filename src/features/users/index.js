const {
  signup,
  signin,
  sendMailData,
  uploadImageData,
} = require("./users.controller");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });
const { validateUserToken } = require("../../middleware/validateUser");

const initializeUsersService = (app) => {
  app.post("/api/signup", signup);
  app.post("/api/signin", signin);
  app.post("/api/sendmail", validateUserToken, sendMailData);

  app.post(
    "/api/uploadimage",
    validateUserToken,
    upload.single("image"),
    uploadImageData
  );
};

module.exports = { initializeUsersService };
