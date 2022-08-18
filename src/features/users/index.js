const {
  signup,
  signin,
  sendMailData,
  uploadImage,
} = require("./users.controller");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

const initializeUsersService = (app) => {
  app.post("/api/signup", signup);
  app.post("/api/signin", signin);
  app.post("/api/sendmail", sendMailData);
  app.post("/api/uploadimage", upload.single("image"), uploadImage);
};

module.exports = { initializeUsersService };
