# Security Policy

This repository contains Emanet core, the data and rules behind 2earl's Emanet apps. It is public
to read but proprietary: see LICENSE.

## Reporting a vulnerability

Write to **legal@2earl.com** with "Security" in the subject. The same contact is published at
<https://2earl.com/.well-known/security.txt>. Please don't disclose it before it's fixed.

Include as much of the following as you can:

- affected endpoint, flow or component
- steps to reproduce or a proof of concept
- impact you believe it has

You will receive an acknowledgement after the report is reviewed.

## Scope

In scope: the code in this repository and its deployment. Sign-in and tokens are 2earl/login's;
the apps are 2earl/emanet-kurumsal, 2earl/emanet-saha and 2earl/emanet-merkez. The same address
takes reports for all of them.

Out of scope: denial-of-service through volumetric traffic, social engineering, and findings in
third-party services (Google, Cloudflare, GitHub).
