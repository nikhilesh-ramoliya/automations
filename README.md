# Base-Backend-Node

# Description

Base Backend project provide basic functionality to build backend nodejs server and also provide features like :

- SignUp
- SignIn
- SendMail
- Image Upload
- Swagger

### To Start Backend Server

```bash
 yarn dev
```

# Folder Structure

## DB

- Configure database using prisma

## Error

- Collection of error classes which used to throw custom Error

## Feature

- API call and it's action

## Middleware

- ErrorHandling File handle error and send appropiate error response message to client and it contain error code
- ValidateUser File handle validate token which comes from cookies. If user token does not match it wll send appropiate response.

## Template

- Contain HTML files which is used to send email format. It has hbs extension means handlebars.

## Utils

### Contain basic utility of app

- Jwt
- password
- S3
- SendMail
- swagger

# JS Doc

## To Generate Documentation

```bash
npx jsdoc src/**/*.js src/**/**/*.js
```
