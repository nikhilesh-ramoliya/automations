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

- Each folder inside this directory contains 4 files.
- swagger.json for swagger ui configuration. This file is mandatory when we create any new feature.
- Controller file for handling logic behind validating request parameters and sending appropiate response. It also contain a function named with initializeFeatureName in which routes are defined.
- Model file as we're using prisma we don't have to write models as the models are already defined in schema.prisma file. But in this project it includes queries like insert, get user, etc.
- Service file contains some business logic.
- To create a new feature, for e.g, to add products then create `products` directory inside features.

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
