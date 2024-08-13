const multer = require('multer');
const dayjs = require('dayjs');
const reader = require('xlsx');
const converter = require('number-to-words');
const { signupUser, signinUser } = require('./users.service');
const { sendMail } = require('../../utils/sendmail');

const upload = multer({ dest: 'uploads/' });
const {
  validateUserToken,
  useErrorHandlingMiddleware,
} = require('../../middleware');
const { EmailSendError } = require('../../error');

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

const sendSalarySlip = async (req, res) => {
  const salaryFile = req.file;
  const readOpts = {
    cellText: false,
    cellDates: true,
  };
  const file = reader.readFile(salaryFile.path, readOpts);
  const data = [];

  const sheets = file.SheetNames;

  for (let i = 0; i < sheets.length; i++) {
    const sheetData = reader.utils.sheet_to_json(
      file.Sheets[file.SheetNames[i]],
      {
        raw: false,
      }
    );
    sheetData.forEach((datum) => {
      data.push(datum);
    });
  }

  const finalData = data
    .filter((item) => item.Emp_ID)
    .map((item) => {
      const employee = { ...item };
      employee.Payslip_For_The_Month = dayjs(
        employee.Payslip_For_The_Month,
        'DD/MM/YYYY'
      ).format('MMMM-YYYY');
      employee.Date_Of_Joining = dayjs(
        employee.Date_Of_Joining,
        'DD/MM/YYY'
      ).format('DD/MM/YYYY');
      employee.Payment_Date = dayjs(employee.Payment_Date).format('DD/MM/YYYY');
      employee.net_salary_in_words = converter.toWords(employee.Net_Salary);
      return employee;
    });
  // .filter((item) => item.Emp_ID === 23);

  // console.log({ data, finalData });
  try {
    // console.log({ finalData });

    // eslint-disable-next-line no-restricted-syntax
    for (const employee of finalData) {
      // eslint-disable-next-line no-await-in-loop
      await sendMail({
        email: employee.Email,
        pdfTemplate: 'salaryslip.hbs',
        data: employee,
        subject: `Salary Slip ${employee.Payslip_For_The_Month}`,
        text: `You can find salary slip for ${employee.Payslip_For_The_Month} as an attachment. Thanks.`,
      });
    }
  } catch (err) {
    throw new EmailSendError('Something went while sending error');
  }

  res.send({ message: 'salary slip has been sent to all the employee' });
};

const sendTemplateMail = async (req, res) => {
  const salaryFile = req.file;
  const readOpts = {
    cellText: false,
    cellDates: true,
  };
  const file = reader.readFile(salaryFile.path, readOpts);
  const data = [];

  const sheets = file.SheetNames;

  for (let i = 0; i < sheets.length; i++) {
    const temp = reader.utils.sheet_to_json(file.Sheets[file.SheetNames[i]]);
    temp.forEach((datum) => {
      data.push(datum);
    });
  }

  const finalData = data.map((item) => {
    const employee = { ...item };
    // you can manipulate data here if you want
    return employee;
  });
  // .filter((item) => item.Emp_ID === 23);

  console.log({ data, finalData });

  try {
    finalData.forEach(async (employee) => {
      await sendMail({
        email: employee.Email,
        htmlTemplate: 'emailTemplate.hbs',
        data: {
          firstName: employee.Name ? employee.Name.split(' ').shift() : '',
        },
      });
    });
  } catch (err) {
    throw new EmailSendError('Something went while sending error');
  }

  res.send({ message: 'salary slip has been sent to all the employee' });
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
    '/api/sendSalarySlip',
    upload.single('salaryData'),
    useErrorHandlingMiddleware(sendSalarySlip)
  );
  app.post(
    '/api/send-mail',
    upload.single('userData'),
    useErrorHandlingMiddleware(sendTemplateMail)
  );
};

module.exports = { initializeUsersService };
