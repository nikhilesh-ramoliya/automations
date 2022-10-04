require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const swaggerUI = require('swagger-ui-express');
const { initializeUsersService } = require('./features/users/users.controller');
const { getSwaggerOptions } = require('./utils/swagger');

const PORT = process.env.PORT || 7000;

const app = express();
app.use(cookieParser());
app.use(express.json());

const getData = async () => {
  const swaggerOptions = await getSwaggerOptions();
  app.use('/api-docs', swaggerUI.serve, swaggerUI.setup(swaggerOptions));
};
getData();

// set header for cookies
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', true);
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  next();
});

initializeUsersService(app);
app.use((err, req, res, next) => {
  if (!err) {
    next();
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Listening port ${PORT}`);
});
