#include "CNative.h"
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <sys/stdio.h>
int gm_open(int root,const char *path,int flags,unsigned mode) {
 return openat(root,path,flags|O_NOFOLLOW_ANY|O_RESOLVE_BENEATH,mode);
}
int gm_publish(int root,const char *temporary,const char *destination) {
 return renameatx_np(root,temporary,root,destination,RENAME_EXCL|RENAME_NOFOLLOW_ANY|RENAME_RESOLVE_BENEATH);
}
int gm_sync(int fd) { if(fsync(fd)!=0)return -1;return fcntl(fd,F_FULLFSYNC); }

#include <string.h>
#include <stdlib.h>
#include <errno.h>
int gm_remove(int root,const char *path) {
 char *copy=strdup(path);if(!copy)return -1;
 char *leaf=strrchr(copy,'/');int parent;
 if(leaf){*leaf++='\0';parent=gm_open(root,copy,O_RDONLY|O_DIRECTORY,0);}else{leaf=copy;parent=dup(root);}
 if(parent<0){free(copy);return -1;}
 int result=unlinkat(parent,leaf,0),saved=errno;close(parent);free(copy);errno=saved;return result;
}
