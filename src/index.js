require("dotenv").config();
const express = require("express");
const { initializeUsersService } = require("./features/users");
const cookieParser = require("cookie-parser");
// const swaggerJsDoc = require("swagger-jsdoc");
const swaggerUI = require("swagger-ui-express");
const swaggerOptions = require("./swaggerOptions.json");

const PORT = process.env.PORT || 7000;

const app = express();
app.use(cookieParser());
app.use(express.json());

app.use("/api-docs", swaggerUI.serve, swaggerUI.setup(swaggerOptions));

//set header for cookies
app.use(function (req, res, next) {
  res.header("Content-Type", "application/json;charset=UTF-8");
  res.header("Access-Control-Allow-Credentials", true);
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  next();
});

//
app.use((err, req, res, next) => {
  // console.log({ err1: err });
  if (!err) {
    next();
    return;
  }

  res.status(500).json(err || { message: "Internal server error" });
});

// app.get("/test", (req, res) => {
//   res.status(201).json({ message: "hello" });
// });
initializeUsersService(app);

app.listen(PORT, () => {
  console.log(`Listening port ${PORT}`);
});
