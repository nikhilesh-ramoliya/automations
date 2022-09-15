const multer = require('multer');
const { signupUser, signinUser } = require('./users.service');
const { sendMail } = require('../../utils/sendmail');

const upload = multer({ dest: 'uploads/' });
const {
  validateUserToken,
  useErrorHandlingMiddleware,
} = require('../../middleware');

const signup = async (req, res) => {
  const { newUser } = await signupUser(req.body);
  res.status(201).json(newUser);
};

const signin = async (req, res) => {
  const { token } = await signinUser(req.body);
  res.cookie('jwtToken', token, {
    expires: new Date(Date.now() + 1000 * 60 * 600),
    httpOnly: true,
    sameSite: 'none',
    secure: true,
  });
  res.json({ message: 'SignIn Successful' });
};

const sendMailData = async (req, res) => {
  const { email } = req.user;
  const isEmailSend = await sendMail({
    email,
    text: 'hello world',
    subject: 'test email',
    pdfTemplate: 'sampleMail.hbs',
    data: { title: 'test title' },
  });
  if (isEmailSend) {
    res.json({ message: 'Message Sent' });
  }
};

const uploadImageData = async (req, res) => {
  const { file } = req;
  console.log({ file });
  // const uploadFileRes = await uploadFile(req.file)
  // await unlinkFile(file.path)
  res.json({ message: 'Image Uploaded' });
};

const initializeUsersService = (app) => {
  app.post('/api/signup', useErrorHandlingMiddleware(signup));
  app.post('/api/signin', useErrorHandlingMiddleware(signin));
  app.post(
    '/api/sendmail',
    useErrorHandlingMiddleware(validateUserToken),
    useErrorHandlingMiddleware(sendMailData)
  );
  app.post(
    '/api/uploadimage',
    useErrorHandlingMiddleware(validateUserToken),
    upload.single('image'),
    useErrorHandlingMiddleware(uploadImageData)
  );
};

module.exports = { initializeUsersService };
