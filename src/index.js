require("dotenv").config();
const express = require("express");
const { initializeUsersService } = require("./features/users");

const PORT = process.env.PORT || 7000;

const app = express();

app.use(express.json());
app.use((err, req, res, next) => {
  // console.log({ err1: err });
  if (!err) {
    next();
    return;
  }

  res.status(500).json(err || { message: "Internal server error" });
});

initializeUsersService(app);

app.listen(PORT, () => {
  console.log(`Listening port ${PORT}`);
});
