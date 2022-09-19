FROM lambci/lambda:build-nodejs12.x

RUN yum install -y libpng-devel libjpeg-devel libwebp-tools libglvnd-glx libXi

# Upgrade to node 16
RUN npm install -g n
RUN n 16

COPY package*.json ./
RUN npm install

COPY index.js index.js
COPY serverless.yml serverless.yaml

CMD export AWS_CLIENT_TIMEOUT=60000

CMD ./node_modules/.bin/serverless deploy