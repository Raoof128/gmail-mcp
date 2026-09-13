#ifndef GMAIL_NATIVE_H
#define GMAIL_NATIVE_H
int gm_open(int root, const char *path, int flags, unsigned mode);
int gm_publish(int root, const char *temporary, const char *destination);
int gm_sync(int fd);
#endif

int gm_remove(int root,const char *path);
