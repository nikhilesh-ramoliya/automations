# Base-Backend-Node

# Description

The Base Backend project provides basic functionality to build backend nodejs servers and also provides features like :

- SignUp
- SignIn
- Send Mail
- Image Upload
- Swagger

### To Start Backend Server

```bash
 yarn dev
```

# Folder Structure

## db

- Database configuration for prisma

## error

- Collection of error classes which used to throw custom Error

## features

- Please refer Readme file inside each feature directory.

## middleware

- ErrorHandling File handle error and send appropiate error response message to client with error code.
- ValidateUser File handle validate token which comes from cookies. If user token does not match it wll send appropiate response.

## template

- Contain HTML files which are used for mail templates. It has hbs extension means handlebars.

## utils

### Contain basic utility of app

- Jwt - generates and verify jwt token
- password - generates and verify hash password
- S3 - upload files to S3 storage
- SendMail - to send email message
- swagger - swagger ui options configuration

# JS Doc

## To Generate Documentation

```bash
npx jsdoc src/**/*.js src/**/**/*.js
```

# ENV Variables

- DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test-database
- JWT_TOKEN_SECRET= - It can be any token secret

### Get this by signing into aws amazon s3 dashboard.

- AWS_BUCKET_NAME=
- AWS_BUCKET_REGION=
- AWS_ACCESS_KEY=
- AWS_SECRET_KEY=

### To get the following environment variables visit this link : https://dev.to/chandrapantachhetri/sending-emails-securely-using-node-js-nodemailer-smtp-gmail-and-oauth2-g3a

- sender_email=
- REFRESH_TOKEN=
- email=sender@email.com
- CLIENT_SECRET=
- CLIENT_ID=
- REDIRECT_URI=
