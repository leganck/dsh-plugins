package main

func helper() int { return 1 }

type S struct{}

func (s *S) Save() int {
	return helper()
}

func Run() {
	s := &S{}
	s.Save()
}
